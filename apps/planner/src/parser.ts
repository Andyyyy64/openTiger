import { readFile } from "node:fs/promises";

// 要件定義の構造
export interface Requirement {
  goal: string;
  background: string;
  constraints: string[];
  acceptanceCriteria: string[];
  scope: {
    inScope: string[];
    outOfScope: string[];
  };
  allowedPaths: string[];
  riskAssessment: RiskItem[];
  notes: string;
  rawContent: string;
}

// リスク項目
export interface RiskItem {
  risk: string;
  impact: "high" | "medium" | "low";
  mitigation: string;
}

export type RequirementFieldName =
  | "goal"
  | "background"
  | "constraints"
  | "acceptanceCriteria"
  | "scope"
  | "allowedPaths"
  | "riskAssessment"
  | "notes";

const DEFAULT_GOAL =
  "Implement the requested outcome described in this requirement in small, verifiable steps.";
const DEFAULT_ALLOWED_PATHS = ["**"];

// Markdownセクションを抽出
function extractSection(content: string, sectionName: string): string {
  const lines = content.split("\n");
  const collected: string[] = [];
  const target = sectionName.trim().toLowerCase();
  let inSection = false;
  let sectionLevel = 0;

  for (const line of lines) {
    const headerMatch = line.match(/^(#{1,6})\s+(.+)\s*$/);
    if (headerMatch) {
      const level = headerMatch[1]?.length ?? 0;
      const header = headerMatch[2]?.trim().toLowerCase();
      if (!inSection && header === target) {
        inSection = true;
        sectionLevel = level;
        continue;
      }
      if (inSection) {
        // レベル1見出し配下では、次のレベル2見出しを別セクションとして扱う。
        const boundaryLevel = sectionLevel === 1 ? 2 : sectionLevel;
        if (level <= boundaryLevel) {
          break;
        }
        collected.push(line);
      }
      continue;
    }

    if (inSection) {
      collected.push(line);
    }
  }

  return collected.join("\n").trim();
}

// リストアイテムを抽出
function extractListItems(content: string): string[] {
  const lines = content.split("\n");
  const items: string[] = [];

  for (const line of lines) {
    const match = line.match(/^\s*[-*]\s+\[?\s*[x ]?\s*\]?\s*(.+)/i);
    const captured = match?.[1];
    if (captured) {
      items.push(captured.trim());
    }
  }

  return items;
}

function normalizePathPattern(path: string): string {
  // Markdown内でエスケープされたワイルドカードを元に戻す
  return path.replace(/\\([*?])/g, "$1");
}

function firstNonEmptyLine(content: string): string | undefined {
  const lines = content.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("#")) {
      continue;
    }
    return line
      .replace(/^[-*]\s+/, "")
      .replace(/^\[[x ]\]\s*/i, "")
      .trim();
  }
  return undefined;
}

function resolveGoal(goalSection: string, rawContent: string): string {
  const explicitGoal = goalSection.trim();
  if (explicitGoal.length > 0) {
    return explicitGoal;
  }
  const fallbackGoal = firstNonEmptyLine(rawContent);
  return fallbackGoal && fallbackGoal.length > 0 ? fallbackGoal : DEFAULT_GOAL;
}

function resolveAcceptanceCriteria(acceptanceSection: string, goal: string): string[] {
  const listed = extractListItems(acceptanceSection);
  if (listed.length > 0) {
    return listed;
  }
  const fallback = firstNonEmptyLine(acceptanceSection);
  if (fallback && fallback.length > 0) {
    return [fallback];
  }
  return [`Deliver a verifiable first increment toward: ${goal}`];
}

// コードブロック内のパスを抽出
function extractPaths(content: string): string[] {
  const paths: string[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    // バッククォートで囲まれたパス
    const codeMatch = line.match(/`([^`]+)`/);
    const codeCapture = codeMatch?.[1];
    if (codeCapture) {
      paths.push(normalizePathPattern(codeCapture));
      continue;
    }

    // リストアイテムのパス
    const listMatch = line.match(/^\s*[-*]\s+(.+)/);
    const listCapture = listMatch?.[1];
    if (listCapture) {
      const path = normalizePathPattern(listCapture.trim());
      if (path.includes("/") || path.includes("*")) {
        paths.push(path);
      }
    }
  }

  return paths;
}

// リスクテーブルをパース
function parseRiskTable(content: string): RiskItem[] {
  const risks: RiskItem[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    // テーブル行をパース（| リスク | 影響度 | 対策 |）
    const match = line.match(/\|\s*([^|]+)\s*\|\s*(高|中|低|high|medium|low)\s*\|\s*([^|]+)\s*\|/i);
    const riskCapture = match?.[1];
    const impactCapture = match?.[2];
    const mitigationCapture = match?.[3];

    if (riskCapture && impactCapture && mitigationCapture) {
      const risk = riskCapture.trim();
      const impactRaw = impactCapture.toLowerCase();
      const mitigation = mitigationCapture.trim();

      // ヘッダー行をスキップ
      if (risk === "リスク" || risk.toLowerCase() === "risk") {
        continue;
      }

      const impactMap: Record<string, "high" | "medium" | "low"> = {
        高: "high",
        中: "medium",
        低: "low",
        high: "high",
        medium: "medium",
        low: "low",
      };

      risks.push({
        risk,
        impact: impactMap[impactRaw] ?? "medium",
        mitigation,
      });
    }
  }

  return risks;
}

// 要件ファイルをパース
export async function parseRequirementFile(filePath: string): Promise<Requirement> {
  const content = await readFile(filePath, "utf-8");
  return parseRequirementContent(content);
}

// 要件テキストをパース
export function parseRequirementContent(content: string): Requirement {
  const goalSection = extractSection(content, "Goal");
  const backgroundSection = extractSection(content, "Background");
  const constraintsSection = extractSection(content, "Constraints");
  const acceptanceSection = extractSection(content, "Acceptance Criteria");
  const scopeSection = extractSection(content, "Scope");
  const allowedPathsSection = extractSection(content, "Allowed Paths");
  const riskSection = extractSection(content, "Risk Assessment");
  const notesSection = extractSection(content, "Notes");

  const goal = resolveGoal(goalSection, content);
  const acceptanceCriteria = resolveAcceptanceCriteria(acceptanceSection, goal);
  const parsedAllowedPaths = extractPaths(allowedPathsSection);
  const allowedPaths =
    parsedAllowedPaths.length > 0 ? parsedAllowedPaths : DEFAULT_ALLOWED_PATHS.slice();
  const inScopeContent = extractSection(scopeSection, "In Scope");
  const outOfScopeContent = extractSection(scopeSection, "Out of Scope");

  return {
    goal,
    background: backgroundSection,
    constraints: extractListItems(constraintsSection),
    acceptanceCriteria,
    scope: {
      inScope: extractListItems(inScopeContent),
      outOfScope: extractListItems(outOfScopeContent),
    },
    allowedPaths,
    riskAssessment: parseRiskTable(riskSection),
    notes: notesSection,
    rawContent: content,
  };
}

export function detectMissingRequirementFields(content: string): RequirementFieldName[] {
  const missing: RequirementFieldName[] = [];
  const goalSection = extractSection(content, "Goal");
  const backgroundSection = extractSection(content, "Background");
  const constraintsSection = extractSection(content, "Constraints");
  const acceptanceSection = extractSection(content, "Acceptance Criteria");
  const scopeSection = extractSection(content, "Scope");
  const allowedPathsSection = extractSection(content, "Allowed Paths");
  const riskSection = extractSection(content, "Risk Assessment");
  const notesSection = extractSection(content, "Notes");

  if (goalSection.trim().length === 0 && !firstNonEmptyLine(content)) {
    missing.push("goal");
  }
  if (backgroundSection.trim().length === 0) {
    missing.push("background");
  }
  if (extractListItems(constraintsSection).length === 0) {
    missing.push("constraints");
  }
  if (extractListItems(acceptanceSection).length === 0) {
    missing.push("acceptanceCriteria");
  }
  const inScope = extractListItems(extractSection(scopeSection, "In Scope"));
  const outOfScope = extractListItems(extractSection(scopeSection, "Out of Scope"));
  if (inScope.length === 0 && outOfScope.length === 0) {
    missing.push("scope");
  }
  if (extractPaths(allowedPathsSection).length === 0) {
    missing.push("allowedPaths");
  }
  if (parseRiskTable(riskSection).length === 0) {
    missing.push("riskAssessment");
  }
  if (notesSection.trim().length === 0) {
    missing.push("notes");
  }

  return missing;
}

// 要件の検証
export function validateRequirement(requirement: Requirement): string[] {
  const errors: string[] = [];

  if (!requirement.goal || requirement.goal.trim().length === 0) {
    errors.push("Goal is required");
  }

  if (requirement.acceptanceCriteria.length === 0) {
    errors.push("At least one acceptance criterion is required");
  }

  if (requirement.allowedPaths.length === 0) {
    errors.push("Allowed paths must be specified");
  }

  return errors;
}
