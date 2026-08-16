import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PERSISTED_KEYS = new Set(["diff_comment_drafts"]);
const FLUSH_DELAY_MS = 150;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultStatePath(): string {
  return (
    process.env.PRIMECODEX_SHARED_OBJECTS_FILE?.trim() ||
    path.join(os.homedir(), ".primecodex", "shared-objects.json")
  );
}

export function isPersistedSharedObjectKey(key: string): boolean {
  return PERSISTED_KEYS.has(key);
}

export class PersistentSharedObjectStore {
  private readonly values: Record<string, unknown> = {};
  private flushTimer: NodeJS.Timeout | undefined;
  private writeTail: Promise<void> = Promise.resolve();

  private constructor(private readonly filePath: string) {}

  static async open(
    filePath = defaultStatePath(),
  ): Promise<PersistentSharedObjectStore> {
    const store = new PersistentSharedObjectStore(filePath);
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
      if (isRecord(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (isPersistedSharedObjectKey(key)) store.values[key] = value;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          `[primecodex] failed to load shared object state from ${filePath}`,
          error,
        );
      }
    }
    return store;
  }

  getSnapshot(): Record<string, unknown> {
    return { ...this.values };
  }

  set(key: string, value: unknown): void {
    if (!isPersistedSharedObjectKey(key)) return;
    if (value === undefined) delete this.values[key];
    else this.values[key] = value;
    this.scheduleFlush();
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.flush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush().catch((error) => {
        console.error(
          "[primecodex] failed to persist shared object state",
          error,
        );
      });
    }, FLUSH_DELAY_MS);
    this.flushTimer.unref?.();
  }

  private flush(): Promise<void> {
    const snapshot = JSON.stringify(this.values, null, 2);
    this.writeTail = this.writeTail
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
        await fs.writeFile(temporaryPath, `${snapshot}\n`, "utf8");
        await fs.rename(temporaryPath, this.filePath);
      });
    return this.writeTail;
  }
}
