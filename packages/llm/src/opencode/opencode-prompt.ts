import { readFile } from "node:fs/promises";
import type { OpenCodeOptions } from "./opencode-types";

export async function buildOpenCodePrompt(options: OpenCodeOptions): Promise<string> {
  if (!options.instructionsPath) {
    return options.task;
  }

  // If instructions file exists, prepend it to the task
  const instructions = await readFile(options.instructionsPath, "utf-8");
  const trimmed = instructions.trim();
  if (!trimmed) {
    return options.task;
  }

  return `${trimmed}\n\n${options.task}`;
}
