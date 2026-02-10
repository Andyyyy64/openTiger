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

// 実行コマンドの具体形は verify.contract / LLM 計画で補完する
export async function resolveCheckVerificationCommand(
  _workdir: string,
): Promise<string | undefined> {
  return undefined;
}

// 常駐系コマンドはPlannerから直接提案しない
export async function resolveDevVerificationCommand(_workdir: string): Promise<string | undefined> {
  return undefined;
}

// E2Eの追加可否は task-policies と verify.contract / LLM 計画で判断する
export async function resolveE2EVerificationCommand(_workdir: string): Promise<string | undefined> {
  return undefined;
}
