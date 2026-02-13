import { describe, expect, it } from "vitest";
import {
  buildRuntimeContextSummaries,
  HOST_CONTEXT_CHAR_BUDGET,
  FAILURE_HINT_CHAR_BUDGET,
  TOTAL_CONTEXT_CHAR_BUDGET,
} from "../src/context/prompt-context";
import type { ContextKey } from "../src/context/context-keys";

const HOST_VALUES: Record<ContextKey, string> = {
  "host.os": "Ubuntu 24.04.3 LTS on Windows 10 x86_64",
  "host.kernel": "6.6.87.2-microsoft-standard-WSL2",
  "host.arch": "x86_64",
  "host.shell": "zsh 5.9",
  "host.terminal": "WezTerm",
  "host.cpu": "11th Gen Intel i7-11700K",
  "host.memory": "3056MiB / 24034MiB",
  "host.uptime": "1 hour, 10 mins",
  "tools.node": "v22.16.0",
  "tools.pnpm": "9.15.4",
  "tools.docker": "Docker version 27.5.1",
  "tools.qemu": "QEMU emulator version 9.2.0",
};

describe("buildRuntimeContextSummaries", () => {
  it("injects only relevant host keys from command hints", () => {
    const result = buildRuntimeContextSummaries({
      commands: ["qemu-system-riscv64 -machine virt", "pnpm run check"],
      hostValues: HOST_VALUES,
      promotedKeys: [],
      failureHints: [],
      hostLine: "andy@DESKTOP-R1P403A",
    });

    expect(result.hostContextSummary).toContain("QEMU");
    expect(result.hostContextSummary).toContain("Memory");
    expect(result.hostContextSummary).toContain("Node");
    expect(result.hostContextSummary).not.toContain("Docker");
  });

  it("keeps host and delta summaries within configured budgets", () => {
    const result = buildRuntimeContextSummaries({
      commands: ["docker build .", "pnpm run check", "qemu-system-riscv64 -machine virt"],
      hostValues: HOST_VALUES,
      promotedKeys: ["tools.docker", "host.memory", "host.kernel"],
      failureHints: [
        { signature: "missing_command", count: 7 },
        { signature: "docker_daemon_unreachable", count: 3 },
        { signature: "env_or_auth_mismatch", count: 2 },
      ],
      hostLine: "andy@DESKTOP-R1P403A",
    });

    const hostLength = result.hostContextSummary?.length ?? 0;
    const failureLength = result.failureHintSummary?.length ?? 0;
    const totalLength = hostLength + failureLength;

    expect(hostLength).toBeLessThanOrEqual(HOST_CONTEXT_CHAR_BUDGET);
    expect(failureLength).toBeLessThanOrEqual(FAILURE_HINT_CHAR_BUDGET);
    expect(totalLength).toBeLessThanOrEqual(TOTAL_CONTEXT_CHAR_BUDGET);
  });
});
