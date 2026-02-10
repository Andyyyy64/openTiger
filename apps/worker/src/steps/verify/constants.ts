// ポリシー判定から除外する生成物パターン
export const GENERATED_PATHS = [
  ".openTiger-opencode-*",
  ".openTiger-opencode-*/**",
  "**/.openTiger-opencode-*",
  "**/.openTiger-opencode-*/**",
  "node_modules",
  "node_modules/**",
  "**/node_modules",
  "**/node_modules/**",
  "dist",
  "dist/**",
  "**/dist",
  "**/dist/**",
  ".turbo",
  ".turbo/**",
  "**/.turbo",
  "**/.turbo/**",
  "coverage",
  "coverage/**",
  "**/coverage",
  "**/coverage/**",
  "**/playwright-report/**",
  "**/test-results/**",
  // Judgeのスクラッチリポジトリは成果物扱いしない
  "apps/judge/test-repo",
  "apps/judge/test-repo/**",
  "apps/judge/repro",
  "apps/judge/repro/**",
];

export const ENV_EXAMPLE_PATHS = ["**/.env.example"];
export const GENERATED_EXTENSIONS = [".js", ".d.ts", ".d.ts.map"];

export const DEV_COMMAND_WARMUP_MS = 8000;
export const DEV_PORT_IN_USE_PATTERNS = [/Port\s+\d+\s+is already in use/i, /EADDRINUSE/i];
export const SHELL_CONTROL_PATTERN = /&&|\|\||[|;&<>`]/;
