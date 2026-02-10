import type { OpenCodeOptions, OpenCodeResult } from "../opencode/opencode-types";

export type ClaudeCodeOptions = OpenCodeOptions;
export type ClaudeCodeResult = OpenCodeResult;

export type ClaudePermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "delegate"
  | "dontAsk"
  | "plan";
