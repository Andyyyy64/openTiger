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

// Markdownセクションを抽出
function extractSection(content: string, sectionName: string): string {
  const lines = content.split("\n");
  const collected: string[] = [];
  const target = sectionName.trim().toLowerCase();
  let inSection = false;

  for (const line of lines) {
    const headerMatch = line.match(/^#{1,2}\s+(.+)\s*$/);
    if (headerMatch) {
      const header = headerMatch[1]?.trim().toLowerCase();
      if (inSection) {
        break;
      }
      if (header === target) {
        inSection = true;
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

  // スコープのサブセクションをパース
  const inScopeMatch = scopeSection.match(/^#{2,3}\s+In Scope\s*\n([\s\S]*?)(?=###? |$)/im);
  const outOfScopeMatch = scopeSection.match(/^#{2,3}\s+Out of Scope\s*\n([\s\S]*?)(?=###? |$)/im);
  const inScopeContent = inScopeMatch?.[1] ?? "";
  const outOfScopeContent = outOfScopeMatch?.[1] ?? "";

  return {
    goal: goalSection,
    background: backgroundSection,
    constraints: extractListItems(constraintsSection),
    acceptanceCriteria: extractListItems(acceptanceSection),
    scope: {
      inScope: extractListItems(inScopeContent),
      outOfScope: extractListItems(outOfScopeContent),
    },
    allowedPaths: extractPaths(allowedPathsSection),
    riskAssessment: parseRiskTable(riskSection),
    notes: notesSection,
    rawContent: content,
  };
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
