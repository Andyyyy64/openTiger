import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeNeofetchOutput } from "./normalize-neofetch";

const CONTEXT_DIR = resolve(import.meta.dirname, "../../../../.opentiger/context");
const HOST_SNAPSHOT_PATH = resolve(CONTEXT_DIR, "agent-profile.json");

const SNAPSHOT_SCHEMA_VERSION = 1;
const DEFAULT_TTL_HOURS = 24;
const MAX_NEOFETCH_OUTPUT_LENGTH = 6000;

type ProbeResult = {
  available: boolean;
  output?: string;
  message?: string;
};

export type HostSnapshot = {
  schemaVersion: number;
  collectedAt: string;
  expiresAt: string;
  ttlHours: number;
  fingerprint: string;
  host: {
    hostLine?: string;
    uname?: string;
    os?: string;
    kernel?: string;
    arch?: string;
    shell?: string;
    terminal?: string;
    cpu?: string;
    memory?: string;
    uptime?: string;
  };
  tools: {
    node?: string;
    pnpm?: string;
    docker?: string;
    qemu?: string;
  };
  neofetch: {
    available: boolean;
    checkedAt: string;
    output?: string;
    info: Record<string, string>;
    message?: string;
  };
};

function runCommand(command: string, args: string[], timeoutMs: number): ProbeResult {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    timeout: timeoutMs,
  });
  if (result.error) {
    const errorCode = (result.error as NodeJS.ErrnoException).code;
    return {
      available: false,
      message:
        errorCode === "ENOENT"
          ? `${command} command was not found.`
          : `Failed to execute ${command}: ${result.error.message}`,
    };
  }

  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  if ((result.status ?? 1) !== 0 || !stdout) {
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    const fallback =
      stderr.length > 0 ? stderr : `${command} command did not return a usable output.`;
    return {
      available: false,
      message: fallback,
    };
  }

  return {
    available: true,
    output: stdout,
  };
}

function firstLine(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const line = value.split("\n")[0]?.trim();
  if (!line) {
    return undefined;
  }
  return line;
}

export type UnameSummary = {
  kernelName?: string;
  kernelRelease?: string;
  arch?: string;
  operatingSystem?: string;
};

export function parseUnameSrmo(value: string | undefined): UnameSummary {
  if (!value) {
    return {};
  }
  const tokens = value.trim().split(/\s+/u);
  return {
    kernelName: tokens[0],
    kernelRelease: tokens[1],
    arch: tokens[2],
    operatingSystem: tokens.slice(3).join(" ") || undefined,
  };
}

function extractArchFromText(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const tokens = value.trim().split(/\s+/u);
  const arch = tokens[tokens.length - 1];
  return arch && arch.length > 0 ? arch : undefined;
}

function safeIso(valueMs: number): string {
  return new Date(valueMs).toISOString();
}

function computeFingerprint(source: Record<string, unknown>): string {
  const stable = JSON.stringify(source);
  return createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

function parseSnapshot(raw: string): HostSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const fingerprint = typeof record.fingerprint === "string" ? record.fingerprint : "";
  const expiresAt = typeof record.expiresAt === "string" ? record.expiresAt : "";
  const collectedAt = typeof record.collectedAt === "string" ? record.collectedAt : "";
  if (!fingerprint || !expiresAt || !collectedAt) {
    return null;
  }
  return record as HostSnapshot;
}

export function shouldRefreshSnapshot(
  existing: HostSnapshot | null,
  nextFingerprint: string,
  now: Date = new Date(),
): boolean {
  if (!existing) {
    return true;
  }
  const expiresAtMs = Date.parse(existing.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime()) {
    return true;
  }
  if (existing.fingerprint !== nextFingerprint) {
    return true;
  }
  return false;
}

async function readExistingSnapshot(): Promise<HostSnapshot | null> {
  try {
    const raw = await readFile(HOST_SNAPSHOT_PATH, "utf-8");
    return parseSnapshot(raw);
  } catch {
    return null;
  }
}

async function writeSnapshot(snapshot: HostSnapshot): Promise<void> {
  await mkdir(CONTEXT_DIR, { recursive: true });
  await writeFile(HOST_SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
}

async function collectSnapshotCandidate(now: Date, ttlHours: number): Promise<HostSnapshot> {
  const checkedAt = now.toISOString();
  const expiresAt = safeIso(now.getTime() + ttlHours * 60 * 60 * 1000);

  const unameProbe = runCommand("uname", ["-srmo"], 4000);
  const neofetchProbe = runCommand("neofetch", [], 10000);

  const neofetchOutput = neofetchProbe.output
    ? neofetchProbe.output.slice(0, MAX_NEOFETCH_OUTPUT_LENGTH)
    : undefined;
  const normalizedNeofetch = normalizeNeofetchOutput(neofetchOutput ?? "");

  const uname = firstLine(unameProbe.output);
  const unameSummary = parseUnameSrmo(uname);
  const os = normalizedNeofetch.info.OS ?? unameSummary.operatingSystem ?? unameSummary.kernelName;
  const kernel = normalizedNeofetch.info.Kernel ?? unameSummary.kernelRelease;
  const shell = normalizedNeofetch.info.Shell ?? undefined;
  const terminal = normalizedNeofetch.info.Terminal ?? undefined;
  const cpu = normalizedNeofetch.info.CPU ?? undefined;
  const memory = normalizedNeofetch.info.Memory ?? undefined;
  const uptime = normalizedNeofetch.info.Uptime ?? undefined;
  const arch = unameSummary.arch ?? extractArchFromText(os);
  const tools = {};

  const fingerprint = computeFingerprint({
    uname,
    os,
    kernel,
    arch,
    shell,
    cpu,
    memory,
  });

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    collectedAt: checkedAt,
    expiresAt,
    ttlHours,
    fingerprint,
    host: {
      hostLine: normalizedNeofetch.hostLine,
      uname,
      os,
      kernel,
      arch,
      shell,
      terminal,
      cpu,
      memory,
      uptime,
    },
    tools,
    neofetch: {
      available: neofetchProbe.available && Boolean(neofetchOutput),
      checkedAt,
      output: neofetchOutput,
      info: normalizedNeofetch.info,
      message: neofetchProbe.message,
    },
  };
}

export async function ensureHostSnapshot(
  options: { ttlHours?: number } = {},
): Promise<{ snapshot: HostSnapshot; refreshed: boolean }> {
  const ttlHours =
    typeof options.ttlHours === "number" &&
    Number.isFinite(options.ttlHours) &&
    options.ttlHours > 0
      ? options.ttlHours
      : DEFAULT_TTL_HOURS;

  const now = new Date();
  const candidate = await collectSnapshotCandidate(now, ttlHours);
  const existing = await readExistingSnapshot();
  if (!shouldRefreshSnapshot(existing, candidate.fingerprint, now) && existing) {
    return { snapshot: existing, refreshed: false };
  }

  await writeSnapshot(candidate);
  return { snapshot: candidate, refreshed: true };
}

export function formatNeofetchResponse(snapshot: HostSnapshot): {
  available: boolean;
  checkedAt: string;
  output?: string;
  message?: string;
} {
  if (snapshot.neofetch.available && snapshot.neofetch.output) {
    return {
      available: true,
      checkedAt: snapshot.neofetch.checkedAt,
      output: snapshot.neofetch.output,
    };
  }
  return {
    available: false,
    checkedAt: snapshot.neofetch.checkedAt,
    message: snapshot.neofetch.message ?? "neofetch command did not return a usable output.",
  };
}
