import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Task } from "@openTiger/core";
import {
  CONTEXT_KEY_LABELS,
  CONTEXT_KEYS_PRIORITY,
  isSupportedContextKey,
  type ContextKey,
} from "./context-keys";

const CONTEXT_DIR = resolve(import.meta.dirname, "../../../../.opentiger/context");
const AGENT_PROFILE_PATH = resolve(CONTEXT_DIR, "agent-profile.json");
const CONTEXT_DELTA_PATH = resolve(CONTEXT_DIR, "context-delta.json");

export const HOST_CONTEXT_CHAR_BUDGET = 550;
export const FAILURE_HINT_CHAR_BUDGET = 350;
export const TOTAL_CONTEXT_CHAR_BUDGET = 900;

type HostSnapshot = {
  host?: {
    hostLine?: string;
    os?: string;
    kernel?: string;
    arch?: string;
    shell?: string;
    terminal?: string;
    cpu?: string;
    memory?: string;
    uptime?: string;
  };
  tools?: {
    node?: string;
    pnpm?: string;
    docker?: string;
    qemu?: string;
  };
  neofetch?: {
    info?: Record<string, string>;
  };
};

type ContextDelta = {
  promotedKeys?: string[];
  reasonSignatures?: Array<{
    signature?: string;
    count?: number;
  }>;
};

type FailureHint = {
  signature: string;
  count: number;
};

export type RuntimePromptContext = {
  hostContextSummary?: string;
  failureHintSummary?: string;
};

function normalizeWhitespace(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().replace(/\s+/gu, " ");
  return normalized.length > 0 ? normalized : undefined;
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function toStringRecord(value: unknown): Record<string, string> {
  const record = parseRecord(value);
  if (!record) {
    return {};
  }
  const next: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw !== "string") {
      continue;
    }
    const normalized = normalizeWhitespace(raw);
    if (!normalized) {
      continue;
    }
    next[key] = normalized;
  }
  return next;
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function collectCommandDrivenKeys(commands: string[], failedCommand?: string): Set<ContextKey> {
  const merged = [...commands];
  if (failedCommand && failedCommand.trim().length > 0) {
    merged.push(failedCommand);
  }
  const text = merged.join("\n");
  const keys = new Set<ContextKey>();

  if (/\b(qemu|riscv)\b/iu.test(text)) {
    keys.add("tools.qemu");
    keys.add("host.cpu");
    keys.add("host.memory");
    keys.add("host.arch");
    keys.add("host.kernel");
  }
  if (/\b(docker|container)\b/iu.test(text)) {
    keys.add("tools.docker");
    keys.add("host.os");
    keys.add("host.kernel");
  }
  if (/\b(node|npm|pnpm|yarn|bun|tsc|vitest|eslint|oxlint|turbo)\b/iu.test(text)) {
    keys.add("tools.node");
    keys.add("tools.pnpm");
    keys.add("host.os");
    keys.add("host.shell");
  }
  if (/\b(claude|anthropic)\b/iu.test(text)) {
    keys.add("host.shell");
    keys.add("host.terminal");
  }

  return keys;
}

function toFailureHints(rawDelta: ContextDelta | undefined): FailureHint[] {
  const signatures = rawDelta?.reasonSignatures ?? [];
  const next: FailureHint[] = [];
  for (const entry of signatures) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const signature = normalizeWhitespace(entry.signature);
    const count = typeof entry.count === "number" && Number.isFinite(entry.count) ? entry.count : 0;
    if (!signature || count <= 0) {
      continue;
    }
    next.push({ signature, count });
  }
  return next.sort((a, b) => b.count - a.count).slice(0, 3);
}

function buildHostValueMap(snapshot: HostSnapshot | undefined): Record<ContextKey, string> {
  const host = parseRecord(snapshot?.host) ?? {};
  const tools = parseRecord(snapshot?.tools) ?? {};
  const neofetchInfo = toStringRecord(parseRecord(snapshot?.neofetch)?.info);
  const map: Partial<Record<ContextKey, string>> = {};

  const assign = (key: ContextKey, ...candidates: Array<unknown>) => {
    for (const candidate of candidates) {
      const normalized = normalizeWhitespace(typeof candidate === "string" ? candidate : undefined);
      if (normalized) {
        map[key] = normalized;
        return;
      }
    }
  };

  assign("host.os", host.os, neofetchInfo.OS);
  assign("host.kernel", host.kernel, neofetchInfo.Kernel);
  assign("host.arch", host.arch);
  assign("host.shell", host.shell, neofetchInfo.Shell);
  assign("host.terminal", host.terminal, neofetchInfo.Terminal);
  assign("host.cpu", host.cpu, neofetchInfo.CPU);
  assign("host.memory", host.memory, neofetchInfo.Memory);
  assign("host.uptime", host.uptime, neofetchInfo.Uptime);
  assign("tools.node", tools.node);
  assign("tools.pnpm", tools.pnpm);
  assign("tools.docker", tools.docker);
  assign("tools.qemu", tools.qemu);

  return map as Record<ContextKey, string>;
}

export function compactLinesToBudget(lines: string[], budget: number): string {
  if (budget <= 0) {
    return "";
  }
  const accepted: string[] = [];
  let used = 0;
  for (const line of lines) {
    const normalized = line.trimEnd();
    if (!normalized) {
      continue;
    }
    const add = normalized.length + (accepted.length > 0 ? 1 : 0);
    if (used + add > budget) {
      break;
    }
    accepted.push(normalized);
    used += add;
  }
  return accepted.join("\n");
}

export function buildRuntimeContextSummaries(params: {
  commands: string[];
  failedCommand?: string;
  hostValues: Record<ContextKey, string>;
  promotedKeys: string[];
  failureHints: FailureHint[];
  hostLine?: string;
}): RuntimePromptContext {
  const commandKeys = collectCommandDrivenKeys(params.commands, params.failedCommand);
  const keys = new Set<ContextKey>();
  for (const key of commandKeys) {
    keys.add(key);
  }
  for (const key of params.promotedKeys) {
    if (isSupportedContextKey(key)) {
      keys.add(key);
    }
  }

  const hostLines: string[] = [];
  const hostLine = normalizeWhitespace(params.hostLine);
  if (hostLine) {
    hostLines.push(`- Host: ${hostLine}`);
  }
  for (const key of CONTEXT_KEYS_PRIORITY) {
    if (!keys.has(key)) {
      continue;
    }
    const value = params.hostValues[key];
    if (!value) {
      continue;
    }
    hostLines.push(`- ${CONTEXT_KEY_LABELS[key]}: ${value}`);
  }

  const failureLines: string[] = [];
  for (const hint of params.failureHints) {
    failureLines.push(`- ${hint.signature} (x${hint.count})`);
  }

  const hostContextSummary = compactLinesToBudget(hostLines, HOST_CONTEXT_CHAR_BUDGET);
  const maxFailureBudget = Math.max(TOTAL_CONTEXT_CHAR_BUDGET - hostContextSummary.length, 0);
  const failureBudget = Math.min(FAILURE_HINT_CHAR_BUDGET, maxFailureBudget);
  const failureHintSummary = compactLinesToBudget(failureLines, failureBudget);

  return {
    hostContextSummary: hostContextSummary || undefined,
    failureHintSummary: failureHintSummary || undefined,
  };
}

export async function buildPromptRuntimeContext(params: {
  task: Task;
  failedCommand?: string;
}): Promise<RuntimePromptContext> {
  const [snapshotRaw, deltaRaw] = await Promise.all([
    readJson(AGENT_PROFILE_PATH),
    readJson(CONTEXT_DELTA_PATH),
  ]);
  const snapshot = (snapshotRaw as HostSnapshot | undefined) ?? undefined;
  const delta = (deltaRaw as ContextDelta | undefined) ?? undefined;

  const promotedKeys = (delta?.promotedKeys ?? []).filter(
    (value): value is string => typeof value === "string",
  );
  const failureHints = toFailureHints(delta);
  const hostValues = buildHostValueMap(snapshot);
  const hostLine = normalizeWhitespace(parseRecord(snapshot?.host)?.hostLine as string | undefined);

  return buildRuntimeContextSummaries({
    commands: params.task.commands ?? [],
    failedCommand: params.failedCommand,
    hostValues,
    promotedKeys,
    failureHints,
    hostLine,
  });
}
