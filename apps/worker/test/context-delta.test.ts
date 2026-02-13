import { describe, expect, it } from "vitest";
import { deriveDeltaUpdateFromFailure } from "../src/context/context-delta";

describe("deriveDeltaUpdateFromFailure", () => {
  it("promotes qemu-related keys when qemu is unavailable", () => {
    const result = deriveDeltaUpdateFromFailure({
      message: "qemu-system-riscv64: command not found",
      failedCommand: "qemu-system-riscv64 -machine virt",
    });

    expect(result.signature).toBe("qemu_unavailable");
    expect(result.promotedKeys).toContain("tools.qemu");
    expect(result.promotedKeys).toContain("host.cpu");
    expect(result.promotedKeys).toContain("host.memory");
  });

  it("promotes docker-related keys on daemon connection errors", () => {
    const result = deriveDeltaUpdateFromFailure({
      message: "permission denied while trying to connect to the docker daemon socket",
      failedCommand: "docker ps",
    });

    expect(result.signature).toBe("docker_daemon_unreachable");
    expect(result.promotedKeys).toContain("tools.docker");
    expect(result.promotedKeys).toContain("host.kernel");
  });

  it("promotes shell/node hints for environment or auth failures", () => {
    const result = deriveDeltaUpdateFromFailure({
      message: "authentication failed because API key is missing",
      failedCommand: "pnpm run check",
    });

    expect(result.signature).toBe("env_or_auth_mismatch");
    expect(result.promotedKeys).toContain("host.shell");
    expect(result.promotedKeys).toContain("tools.node");
  });
});
