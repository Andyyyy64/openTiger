import { describe, expect, it } from "vitest";
import {
  detectMissingRequirementFields,
  parseRequirementContent,
  validateRequirement,
} from "../src/parser";

describe("parseRequirementContent fallbacks", () => {
  it("accepts free-form one-line requirement text", () => {
    const requirement = parseRequirementContent("Build a web app like Airbnb for pets.");

    expect(requirement.goal).toBe("Build a web app like Airbnb for pets.");
    expect(requirement.acceptanceCriteria.length).toBeGreaterThan(0);
    expect(requirement.allowedPaths).toEqual(["**"]);
    expect(validateRequirement(requirement)).toEqual([]);
  });

  it("falls back to wildcard allowed paths when section is missing", () => {
    const requirement = parseRequirementContent(`
# Goal

Ship a tiny internal dashboard.

## Acceptance Criteria

- [ ] Users can view one chart.
`);

    expect(requirement.allowedPaths).toEqual(["**"]);
    expect(validateRequirement(requirement)).toEqual([]);
  });

  it("stops Goal section at level-2 template headers", () => {
    const requirement = parseRequirementContent(`
# Goal

Ship a tiny internal dashboard.

## Background

Context for implementation.

## Acceptance Criteria

- [ ] Users can view one chart.
`);

    expect(requirement.goal).toBe("Ship a tiny internal dashboard.");
    expect(requirement.goal).not.toContain("## Background");
    expect(requirement.background).toContain("Context for implementation.");
  });

  it("parses nested level-3 Allowed Paths section", () => {
    const requirement = parseRequirementContent(`
# Goal

Improve planner robustness.

## Scope

### In Scope

- parser updates

### Allowed Paths

- \`apps/planner/**\`
- \`docs/**\`
`);

    expect(requirement.allowedPaths).toEqual(["apps/planner/**", "docs/**"]);
    expect(validateRequirement(requirement)).toEqual([]);
  });
});

describe("detectMissingRequirementFields", () => {
  it("detects most sections as missing in one-line free text", () => {
    const missing = detectMissingRequirementFields("Build a social photo sharing app.");
    expect(missing).toContain("allowedPaths");
    expect(missing).toContain("acceptanceCriteria");
    expect(missing).toContain("constraints");
  });

  it("does not mark allowedPaths missing when section exists at level-3 heading", () => {
    const missing = detectMissingRequirementFields(`
# Goal
Ship parser update.

### Allowed Paths
- \`apps/planner/**\`
`);
    expect(missing).not.toContain("allowedPaths");
  });
});
