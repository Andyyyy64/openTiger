import { readFile } from "node:fs/promises";
import { join } from "node:path";

async function getRootScript(workdir: string, name: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(workdir, "package.json"), "utf-8");
    const parsed = JSON.parse(raw);
    const scripts = parsed?.scripts as Record<string, string> | undefined;
    return typeof scripts?.[name] === "string" ? scripts[name] : undefined;
  } catch {
    return undefined;
  }
}

export async function hasRootCheckScript(workdir: string): Promise<boolean> {
  const checkScript = await getRootScript(workdir, "check");
  return typeof checkScript === "string";
}

// Concrete commands filled by verify.contract / LLM plan
export async function resolveCheckVerificationCommand(
  _workdir: string,
): Promise<string | undefined> {
  return undefined;
}

// Do not propose long-running commands from Planner
export async function resolveDevVerificationCommand(_workdir: string): Promise<string | undefined> {
  return undefined;
}

// E2E add via task-policies and verify.contract / LLM plan
export async function resolveE2EVerificationCommand(_workdir: string): Promise<string | undefined> {
  return undefined;
}
