import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function stageArtifactDir(dataDir: string, prId: number, stage: string): string {
  return join(dataDir, "artifacts", String(prId), stage);
}

export function writeArtifacts(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
}

/** Read a previously written stage artifact; null if absent/unreadable. */
export function readArtifact(dataDir: string, prId: number, stage: string, name: string): string | null {
  try {
    return readFileSync(join(stageArtifactDir(dataDir, prId, stage), name), "utf8");
  } catch {
    return null;
  }
}
