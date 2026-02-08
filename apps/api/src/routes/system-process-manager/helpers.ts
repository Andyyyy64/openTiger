import { join } from "node:path";
import { resolveRepoRoot } from "../system-requirements";
import type { StartCommand } from "./types";

// ログ出力先は環境変数を優先して決定する
export function resolveLogDir(): string {
  if (process.env.OPENTIGER_LOG_DIR) {
    return process.env.OPENTIGER_LOG_DIR;
  }
  if (process.env.OPENTIGER_RAW_LOG_DIR) {
    return process.env.OPENTIGER_RAW_LOG_DIR;
  }
  return join(resolveRepoRoot(), "raw-logs");
}

export function describeCommand(command: StartCommand): string {
  return [command.command, ...command.args].join(" ");
}

export function parseIndexedProcessName(
  name: string,
  prefix: string,
  options: { allowBaseName?: boolean } = {},
): number | null {
  const allowBaseName = options.allowBaseName ?? false;
  if (allowBaseName && name === prefix) {
    return 1;
  }
  const match = name.match(new RegExp(`^${prefix}-(\\d+)$`));
  if (!match?.[1]) {
    return null;
  }
  const index = Number.parseInt(match[1], 10);
  if (!Number.isFinite(index) || index <= 0) {
    return null;
  }
  return index;
}
