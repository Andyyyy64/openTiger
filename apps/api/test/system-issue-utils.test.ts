import { describe, expect, it } from "vitest";
import { inferRoleFromIssue } from "../src/routes/system-issue-utils";

describe("inferRoleFromIssue", () => {
  it("returns null when explicit role is not provided", () => {
    const role = inferRoleFromIssue({
      labels: [],
      body: [
        "## 概要",
        "lint/format の設定を統合する",
        "## 関連ドキュメント",
        "- docs/README.md",
      ].join("\n"),
    });

    expect(role).toBeNull();
  });

  it("reads explicit role from label", () => {
    const role = inferRoleFromIssue({
      labels: ["role:tester"],
    });

    expect(role).toBe("tester");
  });

  it("reads explicit role from inline body field", () => {
    const role = inferRoleFromIssue({
      labels: [],
      body: "Agent: worker",
    });

    expect(role).toBe("worker");
  });

  it("reads explicit role from markdown section", () => {
    const role = inferRoleFromIssue({
      labels: [],
      body: ["## Agent", "- docser", "", "## Allowed Paths", "- docs/**"].join("\n"),
    });

    expect(role).toBe("docser");
  });

  it("reads explicit role from issue form style section title", () => {
    const role = inferRoleFromIssue({
      labels: [],
      body: ["### Agent Role", "tester", "", "### Summary", "add e2e tests"].join("\n"),
    });

    expect(role).toBe("tester");
  });
});
