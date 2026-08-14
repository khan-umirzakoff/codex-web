import fs from "node:fs/promises";

export type PrimeCodexNewThreadBackend = "codex" | "prime";

export type PrimeCodexControlState = {
  activeBackend: PrimeCodexNewThreadBackend;
  newThreadBackend: PrimeCodexNewThreadBackend;
  selectedProjectId?: string;
  projectCwd?: string;
  projectRoots?: string[];
};

export function parseNewThreadBackend(
  value: unknown,
  fallback: PrimeCodexNewThreadBackend = "codex",
): PrimeCodexNewThreadBackend {
  return value === "prime" || value === "codex" ? value : fallback;
}

export async function readPrimeCodexControlState(
  filePath: string,
  fallback: PrimeCodexControlState,
): Promise<PrimeCodexControlState> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as {
      activeBackend?: unknown;
      newThreadBackend?: unknown;
      selectedProjectId?: unknown;
      projectCwd?: unknown;
      projectRoots?: unknown;
    };
    const projectRoots = Array.isArray(parsed.projectRoots)
      ? parsed.projectRoots.filter(
          (value): value is string =>
            typeof value === "string" && value.length > 0,
        )
      : undefined;
    return {
      activeBackend: parseNewThreadBackend(
        parsed.activeBackend,
        fallback.activeBackend,
      ),
      newThreadBackend: parseNewThreadBackend(
        parsed.newThreadBackend,
        fallback.newThreadBackend,
      ),
      ...(typeof parsed.selectedProjectId === "string"
        ? { selectedProjectId: parsed.selectedProjectId }
        : {}),
      ...(typeof parsed.projectCwd === "string"
        ? { projectCwd: parsed.projectCwd }
        : {}),
      ...(projectRoots && projectRoots.length > 0 ? { projectRoots } : {}),
    };
  } catch {
    return fallback;
  }
}

export async function writePrimeCodexControlState(
  filePath: string,
  state: PrimeCodexControlState,
): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(state)}\n`, "utf8");
}
