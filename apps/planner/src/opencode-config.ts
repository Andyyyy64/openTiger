import { resolve } from "node:path";

// PlannerのLLMはプロンプト内の情報だけで判断できるためツールを無効化する
export const PLANNER_OPENCODE_CONFIG_PATH = resolve(
  import.meta.dirname,
  "../opencode.planner.json"
);
