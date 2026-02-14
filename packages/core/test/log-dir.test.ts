import { describe, expect, it } from "vitest";
import { resolveOpenTigerLogDir } from "../src/log-dir";

describe("resolveOpenTigerLogDir", () => {
  it("falls back to default when placeholder path is configured", () => {
    const result = resolveOpenTigerLogDir({
      fallbackDir: "/repo/raw-logs",
      env: {
        OPENTIGER_LOG_DIR: "/absolute/path/to/openTiger/raw-logs",
      },
    });
    expect(result).toBe("/repo/raw-logs");
  });

  it("uses explicit OPENTIGER_LOG_DIR when it is not placeholder", () => {
    const result = resolveOpenTigerLogDir({
      fallbackDir: "/repo/raw-logs",
      env: {
        OPENTIGER_LOG_DIR: "/tmp/custom-logs",
      },
    });
    expect(result).toBe("/tmp/custom-logs");
  });

  it("uses OPENTIGER_RAW_LOG_DIR when OPENTIGER_LOG_DIR is absent", () => {
    const result = resolveOpenTigerLogDir({
      fallbackDir: "/repo/raw-logs",
      env: {
        OPENTIGER_RAW_LOG_DIR: "/tmp/raw",
      },
    });
    expect(result).toBe("/tmp/raw");
  });
});
