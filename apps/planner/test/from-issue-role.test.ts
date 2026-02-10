import { describe, expect, it } from "vitest";
import {
  generateSimpleTaskFromIssue,
  parseExplicitRoleFromIssue,
  type GitHubIssue,
} from "../src/strategies/from-issue";

function issue(overrides: Partial<GitHubIssue>): GitHubIssue {
  return {
    number: 123,
    title: "[Task] sample",
    body: "",
    labels: [],
    assignees: [],
    ...overrides,
  };
}

describe("issue role resolution", () => {
  it("parses role from label", () => {
    const resolved = parseExplicitRoleFromIssue(issue({ labels: ["role:tester"] }));
    expect(resolved).toBe("tester");
  });

  it("parses role from body inline format", () => {
    const resolved = parseExplicitRoleFromIssue(issue({ body: "Agent: docser" }));
    expect(resolved).toBe("docser");
  });

  it("parses role from bullet inline format", () => {
    const resolved = parseExplicitRoleFromIssue(
      issue({ body: ["## Task", "- Role: worker", "- Goal: implement update API"].join("\n") }),
    );
    expect(resolved).toBe("worker");
  });

  it("returns null when no explicit role exists", () => {
    const resolved = parseExplicitRoleFromIssue(
      issue({
        title: "[Task] E2E テスト作成",
        body: "playwright test を追加",
      }),
    );
    expect(resolved).toBeNull();
  });

  it("does not create simple task when explicit role is missing", () => {
    const result = generateSimpleTaskFromIssue(
      issue({
        number: 456,
        title: "[Task] lint/format",
      }),
      ["apps/**"],
    );

    expect(result.tasks).toHaveLength(0);
    expect(result.warnings[0]).toContain("explicit role is required");
  });
});
