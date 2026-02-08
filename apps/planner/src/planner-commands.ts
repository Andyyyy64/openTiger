import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathIsFile } from "./planner-utils.js";

export async function hasRootCheckScript(workdir: string): Promise<boolean> {
  // ルートのpackage.jsonにcheckスクリプトがあるか確認する
  try {
    const raw = await readFile(join(workdir, "package.json"), "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.scripts?.check === "string";
  } catch {
    return false;
  }
}

export async function resolveCheckVerificationCommand(
  workdir: string
): Promise<string | undefined> {
  if (!(await hasRootCheckScript(workdir))) {
    return undefined;
  }
  if (await pathIsFile(join(workdir, "pnpm-lock.yaml"))) {
    return "pnpm run check";
  }
  if (await pathIsFile(join(workdir, "yarn.lock"))) {
    return "yarn check";
  }
  if (await pathIsFile(join(workdir, "package-lock.json"))) {
    return "npm run check";
  }
  return "npm run check";
}

async function getRootDevScript(workdir: string): Promise<string | undefined> {
  // ルートのpackage.jsonからdevスクリプトを取得する
  try {
    const raw = await readFile(join(workdir, "package.json"), "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.scripts?.dev === "string"
      ? parsed.scripts.dev
      : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveDevVerificationCommand(
  workdir: string
): Promise<string | undefined> {
  const devScript = await getRootDevScript(workdir);
  if (!devScript) {
    return undefined;
  }
  // turbo設定が無いのに `turbo ...` を検証で実行すると高確率で失敗するため除外
  if (/\bturbo\b/.test(devScript)) {
    const hasTurboConfig =
      await pathIsFile(join(workdir, "turbo.json"))
      || await pathIsFile(join(workdir, "turbo.jsonc"));
    if (!hasTurboConfig) {
      return undefined;
    }
  }
  if (await pathIsFile(join(workdir, "pnpm-lock.yaml"))) {
    return "pnpm run dev";
  }
  if (await pathIsFile(join(workdir, "yarn.lock"))) {
    return "yarn dev";
  }
  if (await pathIsFile(join(workdir, "package-lock.json"))) {
    return "npm run dev";
  }
  return "npm run dev";
}

export async function resolveE2EVerificationCommand(
  workdir: string
): Promise<string | undefined> {
  if (await pathIsFile(join(workdir, "pnpm-lock.yaml"))) {
    return "pnpm run e2e";
  }
  if (await pathIsFile(join(workdir, "yarn.lock"))) {
    return "yarn e2e";
  }
  if (await pathIsFile(join(workdir, "package-lock.json"))) {
    return "npm run e2e";
  }
  return "npm run e2e";
}
