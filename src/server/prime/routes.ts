import type { FastifyInstance } from "fastify";
import type { PrimeAgentBackend } from "../backends/prime";
import type { PrimeRpcCommand, PrimeThinkingLevel } from "./rpc-client";

type CreateSessionBody = {
  cwd?: unknown;
  provider?: unknown;
  model?: unknown;
  thinking?: unknown;
  resume?: unknown;
};

type SessionParams = {
  sessionId: string;
};

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  return value;
}

function parseThinking(value: unknown): PrimeThinkingLevel | undefined {
  const thinking = optionalString(value, "thinking");
  if (!thinking) {
    return undefined;
  }

  const allowed: PrimeThinkingLevel[] = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ];
  if (!allowed.includes(thinking as PrimeThinkingLevel)) {
    throw new Error(`Unsupported Prime Agent thinking level: ${thinking}`);
  }
  return thinking as PrimeThinkingLevel;
}

function parseCommand(body: unknown): PrimeRpcCommand {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Prime Agent RPC command must be a JSON object");
  }

  const command = body as Record<string, unknown>;
  if (typeof command.type !== "string" || command.type.length === 0) {
    throw new Error("Prime Agent RPC command requires a string type");
  }
  return command as PrimeRpcCommand;
}

export function registerPrimeAgentRoutes(
  app: FastifyInstance,
  backend: PrimeAgentBackend,
): void {
  app.get("/__backend/prime/sessions", async () => ({
    sessions: backend.sessions.list(),
  }));

  app.post<{ Body: CreateSessionBody }>(
    "/__backend/prime/sessions",
    async (request, reply) => {
      try {
        const cwd = optionalString(request.body?.cwd, "cwd");
        if (!cwd) {
          return reply.code(400).send({ error: "cwd is required" });
        }

        const result = await backend.createSession({
          cwd,
          ...(optionalString(request.body.provider, "provider")
            ? { provider: optionalString(request.body.provider, "provider") }
            : {}),
          ...(optionalString(request.body.model, "model")
            ? { model: optionalString(request.body.model, "model") }
            : {}),
          ...(parseThinking(request.body.thinking)
            ? { thinking: parseThinking(request.body.thinking) }
            : {}),
          ...(optionalString(request.body.resume, "resume")
            ? { resume: optionalString(request.body.resume, "resume") }
            : {}),
        });
        return reply.send(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.code(500).send({ error: message });
      }
    },
  );

  app.get<{ Params: SessionParams }>(
    "/__backend/prime/sessions/:sessionId/state",
    async (request, reply) => {
      try {
        const response = await backend.request(request.params.sessionId, {
          type: "get_state",
        });
        return reply.send(response.data);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.code(404).send({ error: message });
      }
    },
  );

  app.post<{ Params: SessionParams; Body: unknown }>(
    "/__backend/prime/sessions/:sessionId/command",
    async (request, reply) => {
      try {
        const response = await backend.request(
          request.params.sessionId,
          parseCommand(request.body),
        );
        return reply.send(response);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.code(400).send({ error: message });
      }
    },
  );

  app.get<{ Params: SessionParams }>(
    "/__backend/prime/sessions/:sessionId/events",
    async (request, reply) => {
      let unsubscribe: (() => void) | undefined;
      try {
        unsubscribe = backend.onEvent(request.params.sessionId, (event) => {
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.code(404).send({ error: message });
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
      });
      reply.raw.write("event: ready\ndata: {}\n\n");

      request.raw.once("close", () => unsubscribe?.());
    },
  );

  app.delete<{ Params: SessionParams }>(
    "/__backend/prime/sessions/:sessionId",
    async (request, reply) => {
      const removed = await backend.removeSession(request.params.sessionId);
      if (!removed) {
        return reply.code(404).send({ error: "Prime Agent session not found" });
      }
      return reply.code(204).send();
    },
  );
}
