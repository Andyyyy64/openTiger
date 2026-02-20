import type { Requirement } from "./parser";

function pushSection(lines: string[], heading: string, body: string): void {
  lines.push(heading, "", body.trim().length > 0 ? body.trim() : "(none)", "");
}

function pushListSection(lines: string[], heading: string, items: string[]): void {
  lines.push(heading, "");
  if (items.length === 0) {
    lines.push("- (none)", "");
    return;
  }
  for (const item of items) {
    lines.push(`- ${item}`);
  }
  lines.push("");
}

export function formatRequirementMarkdown(requirement: Requirement): string {
  const lines: string[] = [];
  pushSection(lines, "# Goal", requirement.goal);
  pushSection(lines, "## Background", requirement.background);
  pushListSection(lines, "## Constraints", requirement.constraints);

  lines.push("## Acceptance Criteria", "");
  if (requirement.acceptanceCriteria.length === 0) {
    lines.push("- [ ] (to be defined)");
  } else {
    for (const item of requirement.acceptanceCriteria) {
      lines.push(`- [ ] ${item}`);
    }
  }
  lines.push("");

  lines.push("## Scope", "");
  pushListSection(lines, "### In Scope", requirement.scope.inScope);
  pushListSection(lines, "### Out of Scope", requirement.scope.outOfScope);
  pushListSection(
    lines,
    "### Allowed Paths",
    requirement.allowedPaths.map((path) => `\`${path}\``),
  );

  lines.push("## Risk Assessment", "");
  if (requirement.riskAssessment.length === 0) {
    lines.push("- (none)", "");
  } else {
    lines.push("| Risk | Impact | Mitigation |");
    lines.push("| --- | --- | --- |");
    for (const risk of requirement.riskAssessment) {
      lines.push(`| ${risk.risk} | ${risk.impact} | ${risk.mitigation} |`);
    }
    lines.push("");
  }

  pushSection(lines, "## Notes", requirement.notes);
  return `${lines.join("\n").trim()}\n`;
}
