import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function executableExists(command: string): Promise<boolean> {
  if (command.includes(path.sep)) {
    return isExecutable(command);
  }

  const pathEntries = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);

  for (const pathEntry of pathEntries) {
    if (await isExecutable(path.join(pathEntry, command))) {
      return true;
    }
  }

  return false;
}
