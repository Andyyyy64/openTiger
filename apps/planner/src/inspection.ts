import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { runOpenCode } from "@h1ve/llm";
import type { Requirement } from "./parser.js";
import { PLANNER_OPENCODE_CONFIG_PATH } from "./opencode-config.js";

export interface CodebaseInspection {
  summary: string;
  gaps: string[];
  notes: string[];
}

interface RepoSnapshot {
  topLevel: string[];
  fileList: string[];
  readme?: string;
  architecture?: string;
}

const MAX_FILES = 400;
const MAX_README_CHARS = 3000;
const MAX_ARCH_CHARS = 3000;

async function readOptionalFile(path: string, maxChars: number): Promise<string | undefined> {
  try {
    const content = await readFile(path, "utf-8");
    return content.slice(0, maxChars);
  } catch {
    return undefined;
  }
}

async function listTrackedFiles(workdir: string, limit: number): Promise<string[]> {
  return new Promise((resolveResult) => {
    const child = spawn("git", ["ls-files"], {
      cwd: workdir,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
    });

    let stdout = "";
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.on("close", (code) => {
      if (code !== 0) {
        resolveResult([]);
        return;
      }
      const files = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, limit);
      resolveResult(files);
    });

    child.on("error", () => resolveResult([]));
  });
}

async function buildRepoSnapshot(workdir: string): Promise<RepoSnapshot> {
  const entries = await readdir(workdir, { withFileTypes: true });
  const topLevel = entries.map((entry) =>
    entry.isDirectory() ? `${entry.name}/` : entry.name
  );

  const [fileList, readme, architecture] = await Promise.all([
    listTrackedFiles(workdir, MAX_FILES),
    readOptionalFile(join(workdir, "README.md"), MAX_README_CHARS),
    readOptionalFile(join(workdir, "docs/architecture.md"), MAX_ARCH_CHARS),
  ]);

  return {
    topLevel,
    fileList,
    readme,
    architecture,
  };
}

function buildInspectionPrompt(requirement: Requirement, snapshot: RepoSnapshot): string {
  const readmeBlock = snapshot.readme
    ? `\n## README (抜粋)\n${snapshot.readme}`
    : "";
  const architectureBlock = snapshot.architecture
    ? `\n## docs/architecture.md (抜粋)\n${snapshot.architecture}`
    : "";

  return `
あなたは要件と実装の差分を点検するエキスパートです。
以下の要件とリポジトリ情報を読み、未実装/不足/矛盾の可能性を抽出してください。
タスクではなく差分の列挙を目的にします。
ツール呼び出しは禁止です。与えられた情報だけで判断してください。

## 要件
### Goal
${requirement.goal}

### Acceptance Criteria
${requirement.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}

### Constraints
${requirement.constraints.length > 0 ? requirement.constraints.map((c) => `- ${c}`).join("\n") : "(なし)"}

### Scope
In Scope:
${requirement.scope.inScope.map((s) => `- ${s}`).join("\n") || "(なし)"}

Out of Scope:
${requirement.scope.outOfScope.map((s) => `- ${s}`).join("\n") || "(なし)"}

### Allowed Paths
${requirement.allowedPaths.map((p) => `- ${p}`).join("\n")}

### Notes
${requirement.notes || "(なし)"}

## リポジトリ情報
Top-level:
${snapshot.topLevel.map((name) => `- ${name}`).join("\n")}

Tracked files (先頭 ${snapshot.fileList.length} 件):
${snapshot.fileList.map((file) => `- ${file}`).join("\n")}
${readmeBlock}
${architectureBlock}

## 出力形式
以下のJSON形式で出力してください。他のテキストは出力しないでください。

\`\`\`json
{
  "summary": "全体の差分要約（1-2文）",
  "gaps": [
    "未実装/不足/矛盾の可能性",
    "受け入れ条件とのズレ"
  ],
  "notes": [
    "差分の根拠や注意点"
  ]
}
\`\`\`
`.trim();
}

function extractJsonFromResponse(response: string): unknown {
  const codeBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
  const codeBlockContent = codeBlockMatch?.[1];
  if (codeBlockContent) {
    return JSON.parse(codeBlockContent.trim());
  }

  const jsonMatch = response.match(/\{[\s\S]*\}/);
  const jsonContent = jsonMatch?.[0];
  if (jsonContent) {
    return JSON.parse(jsonContent);
  }

  throw new Error("No valid JSON found in response");
}

export async function inspectCodebase(
  requirement: Requirement,
  options: {
    workdir: string;
    timeoutSeconds?: number;
  }
): Promise<CodebaseInspection | undefined> {
  const snapshot = await buildRepoSnapshot(options.workdir);
  const prompt = buildInspectionPrompt(requirement, snapshot);

  const model = process.env.PLANNER_INSPECT_MODEL ?? process.env.PLANNER_MODEL;

  // 差分点検は要件と現状のズレを掘り起こすために行う
  const result = await runOpenCode({
    workdir: options.workdir,
    task: prompt,
    model,
    timeoutSeconds: options.timeoutSeconds ?? 180,
    // Gemini 3系のfunction calling制約を避けるためツールを無効化する
    env: { OPENCODE_CONFIG: PLANNER_OPENCODE_CONFIG_PATH },
  });

  if (!result.success) {
    console.warn("[Planner] Codebase inspection failed:", result.stderr);
    return;
  }

  const parsed = extractJsonFromResponse(result.stdout) as {
    summary?: string;
    gaps?: string[];
    notes?: string[];
  };

  return {
    summary: typeof parsed.summary === "string" ? parsed.summary : "差分点検の要約がありません",
    gaps: Array.isArray(parsed.gaps) ? parsed.gaps.filter((g) => typeof g === "string") : [],
    notes: Array.isArray(parsed.notes) ? parsed.notes.filter((n) => typeof n === "string") : [],
  };
}

export function formatInspectionNotes(inspection: CodebaseInspection): string {
  const lines: string[] = [
    "コードベース差分点検:",
    `概要: ${inspection.summary}`,
  ];

  if (inspection.gaps.length > 0) {
    lines.push("ギャップ:", ...inspection.gaps.map((gap) => `- ${gap}`));
  }

  if (inspection.notes.length > 0) {
    lines.push("補足:", ...inspection.notes.map((note) => `- ${note}`));
  }

  return lines.join("\n");
}
