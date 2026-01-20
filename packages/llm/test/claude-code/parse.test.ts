import { describe, it, expect } from "vitest";
import {
  FileChange,
  extractTokenUsage,
  parseClaudeCodeOutput,
  extractErrorReason,
} from "../../src/claude-code/parse.js";

describe("FileChange schema", () => {
  it("有効なファイル変更を検証できる", () => {
    const change = {
      path: "src/index.ts",
      action: "modify" as const,
      linesAdded: 10,
      linesRemoved: 5,
    };

    const result = FileChange.safeParse(change);
    expect(result.success).toBe(true);
  });

  it("すべてのアクションタイプを受け入れる", () => {
    const actions = ["create", "modify", "delete"] as const;
    for (const action of actions) {
      const change = {
        path: "test.ts",
        action,
        linesAdded: 0,
        linesRemoved: 0,
      };
      expect(FileChange.safeParse(change).success).toBe(true);
    }
  });

  it("負の行数を拒否する", () => {
    const change = {
      path: "test.ts",
      action: "modify" as const,
      linesAdded: -1,
      linesRemoved: 0,
    };
    expect(FileChange.safeParse(change).success).toBe(false);
  });
});

describe("extractTokenUsage", () => {
  it("JSON形式のトークン情報を抽出できる", () => {
    const output = `
      Processing...
      {"input_tokens": 1234, "output_tokens": 5678}
      Done.
    `;

    const usage = extractTokenUsage(output);
    expect(usage).toBeDefined();
    expect(usage?.inputTokens).toBe(1234);
    expect(usage?.outputTokens).toBe(5678);
    expect(usage?.totalTokens).toBe(6912);
  });

  it("テキスト形式のトークン情報を抽出できる", () => {
    const output = `
      Task completed successfully.
      Tokens: 1,234 input, 5,678 output
    `;

    const usage = extractTokenUsage(output);
    expect(usage).toBeDefined();
    expect(usage?.inputTokens).toBe(1234);
    expect(usage?.outputTokens).toBe(5678);
  });

  it("カンマ区切りの数値を正しく処理する", () => {
    const output = "Tokens: 100,000 input, 50,000 output";

    const usage = extractTokenUsage(output);
    expect(usage).toBeDefined();
    expect(usage?.inputTokens).toBe(100000);
    expect(usage?.outputTokens).toBe(50000);
  });

  it("Total tokens形式を抽出できる", () => {
    const output = "Total tokens used: 10,000";

    const usage = extractTokenUsage(output);
    expect(usage).toBeDefined();
    expect(usage?.totalTokens).toBe(10000);
    expect(usage?.inputTokens).toBe(0);
    expect(usage?.outputTokens).toBe(0);
  });

  it("トークン情報がない場合はundefinedを返す", () => {
    const output = "Task completed without token info.";

    const usage = extractTokenUsage(output);
    expect(usage).toBeUndefined();
  });
});

describe("parseClaudeCodeOutput", () => {
  it("ファイル作成を検出できる", () => {
    const output = `
      Created src/new-file.ts
      Created tests/new-file.test.ts
    `;

    const result = parseClaudeCodeOutput(output);
    expect(result.fileChanges).toHaveLength(2);
    expect(result.fileChanges[0]).toEqual({
      path: "src/new-file.ts",
      action: "create",
      linesAdded: 0,
      linesRemoved: 0,
    });
  });

  it("ファイル変更を検出できる", () => {
    const output = "Modified src/index.ts";

    const result = parseClaudeCodeOutput(output);
    expect(result.fileChanges).toHaveLength(1);
    expect(result.fileChanges[0]?.action).toBe("modify");
  });

  it("ファイル削除を検出できる", () => {
    const output = "Deleted src/old-file.ts";

    const result = parseClaudeCodeOutput(output);
    expect(result.fileChanges).toHaveLength(1);
    expect(result.fileChanges[0]?.action).toBe("delete");
  });

  it("実行コマンドを検出できる", () => {
    const output = `
      $ pnpm install
      $ pnpm test
      $ pnpm build
    `;

    const result = parseClaudeCodeOutput(output);
    expect(result.commandsRun).toHaveLength(3);
    expect(result.commandsRun).toContain("pnpm install");
    expect(result.commandsRun).toContain("pnpm test");
    expect(result.commandsRun).toContain("pnpm build");
  });

  it("サマリーを抽出できる", () => {
    const output = `
      Made changes...
      Summary: Added authentication middleware
    `;

    const result = parseClaudeCodeOutput(output);
    expect(result.summary).toBe("Added authentication middleware");
  });

  it("サマリーがない場合はデフォルト値を使用する", () => {
    const output = "Created file.ts";

    const result = parseClaudeCodeOutput(output);
    expect(result.summary).toBe("Changes applied");
  });

  it("トークン使用量を含める", () => {
    const output = `
      Modified src/index.ts
      {"input_tokens": 1000, "output_tokens": 500}
    `;

    const result = parseClaudeCodeOutput(output);
    expect(result.tokenUsage).toBeDefined();
    expect(result.tokenUsage?.totalTokens).toBe(1500);
  });

  it("errorsは空の配列で返される", () => {
    const output = "Some output";

    const result = parseClaudeCodeOutput(output);
    expect(result.errors).toEqual([]);
  });

  it("混合出力を正しく処理する", () => {
    const output = `
      Starting task...
      $ pnpm install
      Created src/auth/login.ts
      Modified src/index.ts
      $ pnpm test
      Summary: Implemented login feature
      Tokens: 5,000 input, 3,000 output
    `;

    const result = parseClaudeCodeOutput(output);
    expect(result.fileChanges).toHaveLength(2);
    expect(result.commandsRun).toHaveLength(2);
    expect(result.summary).toBe("Implemented login feature");
    expect(result.tokenUsage?.inputTokens).toBe(5000);
  });
});

describe("extractErrorReason", () => {
  it("ENOENT エラーを認識する", () => {
    const stderr = "Error: ENOENT: no such file or directory";
    expect(extractErrorReason(stderr)).toBe("File or directory not found");
  });

  it("EACCES エラーを認識する", () => {
    const stderr = "Error: EACCES: permission denied";
    expect(extractErrorReason(stderr)).toBe("Permission denied");
  });

  it("ETIMEDOUT エラーを認識する", () => {
    const stderr = "Error: ETIMEDOUT: connection timed out";
    expect(extractErrorReason(stderr)).toBe("Operation timed out");
  });

  it("rate limit エラーを認識する", () => {
    const stderr = "API rate limit exceeded, please try again later";
    expect(extractErrorReason(stderr)).toBe("API rate limit exceeded");
  });

  it("不明なエラーは最後の行を返す", () => {
    const stderr = `Some context
More info
Actual error message`;
    expect(extractErrorReason(stderr)).toBe("Actual error message");
  });

  it("空のstderrの場合は空文字列を返す", () => {
    // 空のstderrの場合、trim後も空になり、最後の行も空
    const result = extractErrorReason("");
    expect(result).toBe("");
  });

  it("空白のみのstderrの場合はnullを返す", () => {
    // trim後に空になり、split結果の最後がundefinedになる可能性
    const result = extractErrorReason("   \n  \n  ");
    expect(result).toBe("");
  });
});
