import { describe, expect, it } from "vitest";
import {
  extractVerifyReworkMeta,
  stripVerifyReworkMarkers,
} from "../src/cleaners/cleanup-retry/requeue-blocked";

describe("verify rework marker helpers", () => {
  it("extracts verify rework metadata from encoded marker line", () => {
    const payload = encodeURIComponent(
      JSON.stringify({
        failedCommand: "pnpm --filter web run lint",
        failedCommandSource: "auto",
        stderrSummary: "ESLint couldn't find config",
      }),
    );
    const notes = `context line\n[verify-rework-json]${payload}\nother line`;

    const parsed = extractVerifyReworkMeta(notes);

    expect(parsed).toEqual({
      failedCommand: "pnpm --filter web run lint",
      failedCommandSource: "auto",
      stderrSummary: "ESLint couldn't find config",
    });
  });

  it("returns null when marker is malformed", () => {
    const notes = "[verify-rework-json]%%%invalid%%%";

    expect(extractVerifyReworkMeta(notes)).toBeNull();
  });

  it("strips marker lines while keeping other notes", () => {
    const payload = encodeURIComponent(
      JSON.stringify({
        failedCommand: "pnpm --filter web run build",
      }),
    );
    const notes = `line-1\n[verify-rework-json]${payload}\nline-2`;

    expect(stripVerifyReworkMarkers(notes)).toBe("line-1\nline-2");
  });
});
