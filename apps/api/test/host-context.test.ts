import { describe, expect, it } from "vitest";
import { normalizeNeofetchOutput } from "../src/system-context/normalize-neofetch";
import {
  parseUnameSrmo,
  shouldRefreshSnapshot,
  type HostSnapshot,
} from "../src/system-context/host-snapshot";

function createSnapshot(params: {
  fingerprint: string;
  collectedAt: string;
  expiresAt: string;
}): HostSnapshot {
  return {
    schemaVersion: 1,
    fingerprint: params.fingerprint,
    collectedAt: params.collectedAt,
    expiresAt: params.expiresAt,
    ttlHours: 24,
    host: {},
    tools: {},
    neofetch: {
      available: false,
      checkedAt: params.collectedAt,
      info: {},
    },
  };
}

describe("normalizeNeofetchOutput", () => {
  it("extracts host line and info fields", () => {
    const raw = [
      "\u001b[32mandy@DESKTOP-R1P403A\u001b[0m",
      "--------------------",
      "OS: Ubuntu 24.04.3 LTS on Windows 10 x86_64",
      "Kernel: 6.6.87.2-microsoft-standard-WSL2",
      "Shell: zsh 5.9",
      "Memory: 3056MiB / 24034MiB",
    ].join("\n");

    const parsed = normalizeNeofetchOutput(raw);
    expect(parsed.hostLine).toBe("andy@DESKTOP-R1P403A");
    expect(parsed.info.OS).toBe("Ubuntu 24.04.3 LTS on Windows 10 x86_64");
    expect(parsed.info.Kernel).toBe("6.6.87.2-microsoft-standard-WSL2");
    expect(parsed.info.Shell).toBe("zsh 5.9");
    expect(parsed.info.Memory).toBe("3056MiB / 24034MiB");
  });
});

describe("parseUnameSrmo", () => {
  it("extracts kernel and architecture from uname -srmo output", () => {
    const parsed = parseUnameSrmo("Linux 6.6.87.2-microsoft-standard-WSL2 x86_64 GNU/Linux");
    expect(parsed.kernelName).toBe("Linux");
    expect(parsed.kernelRelease).toBe("6.6.87.2-microsoft-standard-WSL2");
    expect(parsed.arch).toBe("x86_64");
    expect(parsed.operatingSystem).toBe("GNU/Linux");
  });
});

describe("shouldRefreshSnapshot", () => {
  it("returns true when snapshot does not exist", () => {
    expect(shouldRefreshSnapshot(null, "abc123", new Date("2026-01-01T00:00:00.000Z"))).toBe(true);
  });

  it("returns true when snapshot is expired", () => {
    const snapshot = createSnapshot({
      fingerprint: "abc123",
      collectedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T01:00:00.000Z",
    });
    expect(shouldRefreshSnapshot(snapshot, "abc123", new Date("2026-01-01T01:00:00.001Z"))).toBe(
      true,
    );
  });

  it("returns true when fingerprint changed before ttl", () => {
    const snapshot = createSnapshot({
      fingerprint: "abc123",
      collectedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-02T00:00:00.000Z",
    });
    expect(shouldRefreshSnapshot(snapshot, "next999", new Date("2026-01-01T06:00:00.000Z"))).toBe(
      true,
    );
  });

  it("returns false when ttl is valid and fingerprint unchanged", () => {
    const snapshot = createSnapshot({
      fingerprint: "abc123",
      collectedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-02T00:00:00.000Z",
    });
    expect(shouldRefreshSnapshot(snapshot, "abc123", new Date("2026-01-01T06:00:00.000Z"))).toBe(
      false,
    );
  });
});
