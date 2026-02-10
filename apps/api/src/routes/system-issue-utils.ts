export function normalizeAllowedPathToken(token: string): string[] {
  let value = token.trim();
  value = value.replace(/^`+|`+$/g, "");
  value = value.replace(/^"+|"+$/g, "");
  value = value.replace(/^'+|'+$/g, "");
  // Markdownのエスケープ(\*\*)を元に戻す
  value = value.replace(/\\([*?])/g, "$1");
  value = value.replace(/^\.\//, "");
  value = value.trim();

  if (!value || value === "." || value === "/" || value === "./") {
    return ["**"];
  }
  if (value.includes("*")) {
    return [value];
  }
  if (value.endsWith("/")) {
    value = value.slice(0, -1);
  }

  const basename = value.split("/").pop() ?? value;
  const looksLikeFile = basename.includes(".");
  if (looksLikeFile) {
    return [value];
  }
  return [value, `${value}/**`];
}

export function parseAllowedPathsFromIssueBody(body: string): string[] {
  if (!body) {
    return ["**"];
  }
  const lines = body.split(/\r?\n/);
  const tokens: string[] = [];
  let inSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#{1,6}\s*allowed\s*paths?\b/i.test(trimmed)) {
      inSection = true;
      continue;
    }
    if (inSection && /^#{1,6}\s+/.test(trimmed)) {
      break;
    }
    if (!inSection) {
      continue;
    }

    const bulletMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (bulletMatch?.[1]) {
      tokens.push(bulletMatch[1]);
      continue;
    }
    if (trimmed.length > 0) {
      tokens.push(trimmed);
    }
  }

  if (tokens.length === 0) {
    const inlineMatch = body.match(/allowed\s*paths?\s*:\s*([^\n]+)/i);
    if (inlineMatch?.[1]) {
      tokens.push(...inlineMatch[1].split(","));
    }
  }

  const normalized = new Set<string>();
  for (const token of tokens) {
    for (const value of normalizeAllowedPathToken(token)) {
      normalized.add(value);
    }
  }

  if (normalized.size === 0) {
    normalized.add("**");
  }
  return Array.from(normalized);
}

export function parseIssueNumberRefs(text: string): number[] {
  const numbers = new Set<number>();
  for (const match of text.matchAll(/(?:#|\/issues\/)(\d{1,10})\b/g)) {
    const parsed = Number.parseInt(match[1] ?? "", 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      numbers.add(parsed);
    }
  }
  return Array.from(numbers);
}

export function parseDependencyIssueNumbersFromIssueBody(body: string): number[] {
  if (!body) {
    return [];
  }

  const numbers = new Set<number>();
  const lines = body.split(/\r?\n/);
  let inDependencySection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    if (
      /^#{1,6}\s*(dependencies?|depends\s*on|blocked\s*by|dependency|依存関係)\b/i.test(trimmed)
    ) {
      inDependencySection = true;
      continue;
    }
    if (inDependencySection && /^#{1,6}\s+/.test(trimmed)) {
      inDependencySection = false;
    }

    if (inDependencySection) {
      for (const number of parseIssueNumberRefs(trimmed)) {
        numbers.add(number);
      }
      continue;
    }

    if (/(depends?\s*on|blocked\s*by|requires?|dependency|依存)/i.test(trimmed)) {
      for (const number of parseIssueNumberRefs(trimmed)) {
        numbers.add(number);
      }
    }
  }

  return Array.from(numbers);
}

export type IssueTaskRole = "worker" | "tester" | "docser";

function normalizeRoleToken(value: string | null | undefined): IssueTaskRole | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "worker" || normalized === "tester" || normalized === "docser") {
    return normalized;
  }
  return null;
}

function parseRoleFromLabels(labels: string[]): IssueTaskRole | null {
  for (const raw of labels) {
    const label = raw.trim().toLowerCase().replace(/\s+/g, "");
    if (label === "role:worker" || label === "agent:worker" || label === "worker") {
      return "worker";
    }
    if (label === "role:tester" || label === "agent:tester" || label === "tester") {
      return "tester";
    }
    if (label === "role:docser" || label === "agent:docser" || label === "docser") {
      return "docser";
    }
  }
  return null;
}

function parseRoleFromInlineBody(body: string): IssueTaskRole | null {
  if (!body) {
    return null;
  }

  const inline = body.match(
    /^(?:\s*[-*]\s*)?(?:agent(?:\s*role)?|role|担当(?:エージェント)?|実行エージェント)\s*[:：]\s*(worker|tester|docser)\s*$/im,
  );
  return normalizeRoleToken(inline?.[1] ?? null);
}

function parseRoleFromSectionBody(body: string): IssueTaskRole | null {
  if (!body) {
    return null;
  }

  const lines = body.split(/\r?\n/);
  let inRoleSection = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }

    if (/^#{1,6}\s*(agent|role|担当(?:エージェント)?|実行エージェント)\b/i.test(line)) {
      inRoleSection = true;
      continue;
    }

    if (inRoleSection && /^#{1,6}\s+/.test(line)) {
      break;
    }

    if (!inRoleSection) {
      continue;
    }

    const bullet = line.match(/^[-*]\s*(.+)$/)?.[1] ?? line;
    const sectionRole = bullet.match(/\b(worker|tester|docser)\b/i)?.[1] ?? null;
    const normalized = normalizeRoleToken(sectionRole);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

export function parseExplicitRoleFromIssue(params: {
  labels: string[];
  body?: string;
}): IssueTaskRole | null {
  const fromLabel = parseRoleFromLabels(params.labels);
  if (fromLabel) {
    return fromLabel;
  }
  const body = params.body ?? "";
  const fromInlineBody = parseRoleFromInlineBody(body);
  if (fromInlineBody) {
    return fromInlineBody;
  }
  return parseRoleFromSectionBody(body);
}

export function inferRoleFromIssue(params: {
  labels: string[];
  body?: string;
}): IssueTaskRole | null {
  return parseExplicitRoleFromIssue({
    labels: params.labels,
    body: params.body,
  });
}

export function inferRoleFromLabels(labels: string[]): IssueTaskRole | null {
  return inferRoleFromIssue({ labels });
}

export function inferRiskFromLabels(labels: string[]): "low" | "medium" | "high" {
  const lower = labels.map((label) => label.toLowerCase());
  if (
    lower.some(
      (label) =>
        label.includes("critical") || label.includes("security") || label.includes("urgent"),
    )
  ) {
    return "high";
  }
  if (
    lower.some(
      (label) => label.includes("bug") || label.includes("important") || label.includes("fix"),
    )
  ) {
    return "medium";
  }
  return "low";
}

export function inferPriorityFromLabels(labels: string[]): number {
  const lower = labels.map((label) => label.toLowerCase());
  if (
    lower.some(
      (label) => label.includes("priority:high") || label.includes("p0") || label.includes("p1"),
    )
  ) {
    return 90;
  }
  if (lower.some((label) => label.includes("priority:medium") || label.includes("p2"))) {
    return 60;
  }
  return 40;
}

export function parseLinkedIssueNumbersFromPr(title: string, body: string): number[] {
  const numbers = new Set<number>();
  const lines = `${title}\n${body}`.split(/\r?\n/);

  for (const line of lines) {
    const normalized = line.trim();
    if (!normalized) {
      continue;
    }

    if (
      /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?|related|issue|closes|fixes|resolves)\b/i.test(
        normalized,
      )
    ) {
      for (const issueNumber of parseIssueNumberRefs(normalized)) {
        numbers.add(issueNumber);
      }
    }
  }

  // Handle cases where multiple closing keywords appear on one line
  for (const match of `${title}\n${body}`.matchAll(
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b([^\n]+)/gi,
  )) {
    for (const issueNumber of parseIssueNumberRefs(match[1] ?? "")) {
      numbers.add(issueNumber);
    }
  }

  return Array.from(numbers);
}

export function extractIssueNumberFromTaskContext(context: unknown): number | null {
  if (!context || typeof context !== "object") {
    return null;
  }
  const issue = (context as { issue?: unknown }).issue;
  if (!issue || typeof issue !== "object") {
    return null;
  }
  const number = (issue as { number?: unknown }).number;
  if (typeof number !== "number" || !Number.isInteger(number)) {
    return null;
  }
  return number;
}
