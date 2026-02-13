import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CONTEXT_KEYS_PRIORITY, isSupportedContextKey, type ContextKey } from "./context-keys";

const CONTEXT_DIR = resolve(import.meta.dirname, "../../../../.opentiger/context");
const CONTEXT_DELTA_PATH = resolve(CONTEXT_DIR, "context-delta.json");

const CONTEXT_DELTA_SCHEMA_VERSION = 1;
const CONTEXT_DELTA_TTL_HOURS = 24;
const MAX_PROMOTED_KEYS = 12;
const MAX_REASON_SIGNATURES = 12;
const MAX_REASON_MESSAGE_LENGTH = 180;

type FailureReason = {
  signature: string;
  count: number;
  lastSeenAt: string;
  lastMessage: string;
  addedKeys: ContextKey[];
};

type ContextDeltaFile = {
  schemaVersion: number;
  updatedAt: string;
  expireAt: string;
  promotedKeys: ContextKey[];
  reasonSignatures: FailureReason[];
};

export type DeltaUpdate = {
  signature: string;
  promotedKeys: ContextKey[];
  message: string;
};

function normalizeMessage(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function toContextKeyList(keys: Iterable<ContextKey>): ContextKey[] {
  const set = new Set(keys);
  const ordered = CONTEXT_KEYS_PRIORITY.filter((key) => set.has(key));
  return ordered.slice(0, MAX_PROMOTED_KEYS);
}

function inferCommandSpecificKeys(command: string): ContextKey[] {
  const normalized = command.toLowerCase();
  const keys = new Set<ContextKey>();
  if (normalized.includes("qemu") || normalized.includes("riscv")) {
    keys.add("tools.qemu");
    keys.add("host.cpu");
    keys.add("host.memory");
  }
  if (normalized.includes("docker") || normalized.includes("container")) {
    keys.add("tools.docker");
    keys.add("host.os");
    keys.add("host.kernel");
  }
  if (
    normalized.includes("node") ||
    normalized.includes("npm") ||
    normalized.includes("pnpm") ||
    normalized.includes("yarn") ||
    normalized.includes("bun")
  ) {
    keys.add("tools.node");
    keys.add("tools.pnpm");
    keys.add("host.shell");
  }
  return Array.from(keys);
}

export function deriveDeltaUpdateFromFailure(params: {
  message: string;
  failedCommand?: string;
}): DeltaUpdate {
  const normalizedMessage = normalizeMessage(params.message);
  const normalizedCommand = normalizeMessage(params.failedCommand ?? "");
  const haystack = `${normalizedMessage}\n${normalizedCommand}`.toLowerCase();
  const promoted = new Set<ContextKey>(inferCommandSpecificKeys(normalizedCommand));
  let signature = "general_failure";

  if (
    /docker daemon|cannot connect to the docker daemon|permission denied while trying to connect to the docker daemon socket/u.test(
      haystack,
    )
  ) {
    signature = "docker_daemon_unreachable";
    promoted.add("tools.docker");
    promoted.add("host.os");
    promoted.add("host.kernel");
  } else if (/qemu-system-riscv64|qemu: command not found|qemu not found/u.test(haystack)) {
    signature = "qemu_unavailable";
    promoted.add("tools.qemu");
    promoted.add("host.cpu");
    promoted.add("host.memory");
  } else if (/command not found|enoent|executable file not found in \$path/u.test(haystack)) {
    signature = "missing_command";
    promoted.add("tools.node");
    promoted.add("tools.pnpm");
    promoted.add("tools.docker");
    promoted.add("tools.qemu");
    promoted.add("host.shell");
  } else if (
    /authentication failed|not authenticated|api key|environment variable|missing .*token/u.test(
      haystack,
    )
  ) {
    signature = "env_or_auth_mismatch";
    promoted.add("host.os");
    promoted.add("host.shell");
    promoted.add("tools.node");
  }

  return {
    signature,
    promotedKeys: toContextKeyList(promoted),
    message: normalizedMessage.slice(0, MAX_REASON_MESSAGE_LENGTH),
  };
}

function buildEmptyDelta(now: Date): ContextDeltaFile {
  return {
    schemaVersion: CONTEXT_DELTA_SCHEMA_VERSION,
    updatedAt: now.toISOString(),
    expireAt: new Date(now.getTime() + CONTEXT_DELTA_TTL_HOURS * 60 * 60 * 1000).toISOString(),
    promotedKeys: [],
    reasonSignatures: [],
  };
}

function isExpired(delta: ContextDeltaFile, now: Date): boolean {
  const expireAtMs = Date.parse(delta.expireAt);
  return !Number.isFinite(expireAtMs) || expireAtMs <= now.getTime();
}

function parseDelta(value: unknown): ContextDeltaFile | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.updatedAt !== "string" || typeof record.expireAt !== "string") {
    return null;
  }

  const promotedKeysRaw = Array.isArray(record.promotedKeys) ? record.promotedKeys : [];
  const promotedKeys = promotedKeysRaw
    .filter((key): key is string => typeof key === "string")
    .filter((key): key is ContextKey => isSupportedContextKey(key));

  const reasonSignaturesRaw = Array.isArray(record.reasonSignatures) ? record.reasonSignatures : [];
  const reasonSignatures: FailureReason[] = [];
  for (const item of reasonSignaturesRaw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const row = item as Record<string, unknown>;
    const signature = typeof row.signature === "string" ? normalizeMessage(row.signature) : "";
    const count = typeof row.count === "number" && Number.isFinite(row.count) ? row.count : 0;
    const lastSeenAt = typeof row.lastSeenAt === "string" ? row.lastSeenAt : "";
    const lastMessage =
      typeof row.lastMessage === "string" ? normalizeMessage(row.lastMessage) : "";
    const addedKeysRaw = Array.isArray(row.addedKeys) ? row.addedKeys : [];
    const addedKeys = addedKeysRaw
      .filter((key): key is string => typeof key === "string")
      .filter((key): key is ContextKey => isSupportedContextKey(key));
    if (!signature || count <= 0 || !lastSeenAt) {
      continue;
    }
    reasonSignatures.push({
      signature,
      count,
      lastSeenAt,
      lastMessage,
      addedKeys,
    });
  }

  return {
    schemaVersion:
      typeof record.schemaVersion === "number"
        ? record.schemaVersion
        : CONTEXT_DELTA_SCHEMA_VERSION,
    updatedAt: record.updatedAt,
    expireAt: record.expireAt,
    promotedKeys: toContextKeyList(promotedKeys),
    reasonSignatures: reasonSignatures
      .sort((a, b) => {
        if (b.count !== a.count) {
          return b.count - a.count;
        }
        return Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
      })
      .slice(0, MAX_REASON_SIGNATURES),
  };
}

async function readCurrentDelta(now: Date): Promise<ContextDeltaFile> {
  try {
    const raw = await readFile(CONTEXT_DELTA_PATH, "utf-8");
    const parsed = parseDelta(JSON.parse(raw) as unknown);
    if (!parsed || isExpired(parsed, now)) {
      return buildEmptyDelta(now);
    }
    return parsed;
  } catch {
    return buildEmptyDelta(now);
  }
}

async function persistDelta(delta: ContextDeltaFile): Promise<void> {
  await mkdir(CONTEXT_DIR, { recursive: true });
  await writeFile(CONTEXT_DELTA_PATH, `${JSON.stringify(delta, null, 2)}\n`, "utf-8");
}

export async function recordContextDeltaFailure(params: {
  message: string;
  failedCommand?: string;
}): Promise<void> {
  const now = new Date();
  const update = deriveDeltaUpdateFromFailure(params);
  const current = await readCurrentDelta(now);

  const mergedKeys = new Set<ContextKey>(current.promotedKeys);
  for (const key of update.promotedKeys) {
    mergedKeys.add(key);
  }

  const reasonMap = new Map<string, FailureReason>();
  for (const reason of current.reasonSignatures) {
    reasonMap.set(reason.signature, reason);
  }
  const existing = reasonMap.get(update.signature);
  const nextReason: FailureReason = existing
    ? {
        signature: existing.signature,
        count: existing.count + 1,
        lastSeenAt: now.toISOString(),
        lastMessage: update.message,
        addedKeys: toContextKeyList(new Set([...existing.addedKeys, ...update.promotedKeys])),
      }
    : {
        signature: update.signature,
        count: 1,
        lastSeenAt: now.toISOString(),
        lastMessage: update.message,
        addedKeys: update.promotedKeys,
      };
  reasonMap.set(update.signature, nextReason);

  const reasonSignatures = Array.from(reasonMap.values())
    .sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      return Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
    })
    .slice(0, MAX_REASON_SIGNATURES);

  const nextDelta: ContextDeltaFile = {
    schemaVersion: CONTEXT_DELTA_SCHEMA_VERSION,
    updatedAt: now.toISOString(),
    expireAt: new Date(now.getTime() + CONTEXT_DELTA_TTL_HOURS * 60 * 60 * 1000).toISOString(),
    promotedKeys: toContextKeyList(mergedKeys),
    reasonSignatures,
  };
  await persistDelta(nextDelta);
}
