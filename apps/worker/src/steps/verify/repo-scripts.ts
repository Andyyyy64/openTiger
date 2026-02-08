import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function loadRootScripts(repoPath: string): Promise<Record<string, string>> {
  try {
    const content = await readFile(join(repoPath, "package.json"), "utf-8");
    const parsed = JSON.parse(content) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}

export async function hasRootCheckScript(repoPath: string): Promise<boolean> {
  try {
    const raw = await readFile(join(repoPath, "package.json"), "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.scripts?.check === "string";
  } catch {
    return false;
  }
}
