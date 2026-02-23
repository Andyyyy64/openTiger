import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

const DEFAULT_COMMAND_DRIVEN_ALLOWED_PATH_RULES = [
  { pattern: "\\bmake\\b", paths: ["Makefile"] },
  { pattern: "\\bcmake\\b", paths: ["CMakeLists.txt"] },
  { pattern: "\\bninja\\b", paths: ["build.ninja"] },
  { pattern: "\\bcargo\\b", paths: ["Cargo.toml", "Cargo.lock"] },
  { pattern: "\\bgo\\b", paths: ["go.mod", "go.sum"] },
  { pattern: "\\b(gradle|gradlew)\\b", paths: ["build.gradle", "build.gradle.kts"] },
  { pattern: "\\b(gradle|gradlew)\\b", paths: ["settings.gradle", "settings.gradle.kts"] },
  { pattern: "\\b(gradle|gradlew)\\b", paths: ["gradle.properties"] },
  { pattern: "\\b(mvn|mvnw|maven)\\b", paths: ["pom.xml"] },
  { pattern: "\\b(bazel|bazelisk)\\b", paths: ["WORKSPACE", "WORKSPACE.bazel", "MODULE.bazel"] },
  { pattern: "\\b(bazel|bazelisk)\\b", paths: ["BUILD.bazel"] },
] as const;

const DEFAULT_INFRA_SIGNAL_TOKENS = [
  "make",
  "cmake",
  "ninja",
  "cargo",
  "gradle",
  "mvn",
  "meson",
  "gcc",
  "clang",
  "ld",
  "objdump",
  "readelf",
  "build",
  "compile",
  "link",
  "toolchain",
  "bootstrap",
  "setup",
] as const;

const DEFAULT_SAFE_INFRA_FILE_BASENAMES = [
  "makefile",
  "cmakelists.txt",
  "build.ninja",
  "cargo.toml",
  "cargo.lock",
  "go.mod",
  "go.sum",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradle.properties",
  "pom.xml",
  "workspace",
  "workspace.bazel",
  "module.bazel",
  "build.bazel",
] as const;

const DEFAULT_SAFE_INFRA_FILE_EXTENSIONS = [".ld", ".lds"] as const;
const DEFAULT_SAFE_HIDDEN_ROOT_FILES = [".gitignore", ".env.example"] as const;

const commandRuleSchema = z.object({
  pattern: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
});

const policyRecoveryFileSchema = z.object({
  mode: z.enum(["conservative", "balanced", "aggressive"]).optional(),
  replaceDefaultCommandDrivenAllowedPathRules: z.boolean().optional(),
  commandDrivenAllowedPathRules: z.array(commandRuleSchema).optional(),
  infraSignalTokens: z.array(z.string().min(1)).optional(),
  safeInfraFileBasenames: z.array(z.string().min(1)).optional(),
  safeInfraFileExtensions: z.array(z.string().min(1)).optional(),
  safeHiddenRootFiles: z.array(z.string().min(1)).optional(),
});

export type PolicyRecoveryMode = "conservative" | "balanced" | "aggressive";

export type CommandDrivenAllowedPathRule = {
  pattern: string;
  paths: string[];
};

export type PolicyRecoveryConfig = {
  mode: PolicyRecoveryMode;
  commandDrivenAllowedPathRules: CommandDrivenAllowedPathRule[];
  infraSignalTokens: string[];
  safeInfraFileBasenames: string[];
  safeInfraFileExtensions: string[];
  safeHiddenRootFiles: string[];
};

type PolicyRecoveryFileConfig = z.infer<typeof policyRecoveryFileSchema>;

function toUniqueList(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function parseMode(raw: string | undefined): PolicyRecoveryMode | null {
  const normalized = (raw ?? "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "conservative" || normalized === "balanced" || normalized === "aggressive") {
    return normalized;
  }
  return null;
}

function parseEnvJsonConfig(): PolicyRecoveryFileConfig | null {
  const raw = process.env.POLICY_RECOVERY_CONFIG_JSON?.trim();
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return policyRecoveryFileSchema.parse(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[PolicyRecovery] Failed to parse POLICY_RECOVERY_CONFIG_JSON: ${message}`);
    return null;
  }
}

export function getDefaultPolicyRecoveryConfig(): PolicyRecoveryConfig {
  return {
    mode: "aggressive",
    commandDrivenAllowedPathRules: DEFAULT_COMMAND_DRIVEN_ALLOWED_PATH_RULES.map((rule) => ({
      pattern: rule.pattern,
      paths: [...rule.paths],
    })),
    infraSignalTokens: [...DEFAULT_INFRA_SIGNAL_TOKENS],
    safeInfraFileBasenames: [...DEFAULT_SAFE_INFRA_FILE_BASENAMES],
    safeInfraFileExtensions: [...DEFAULT_SAFE_INFRA_FILE_EXTENSIONS],
    safeHiddenRootFiles: [...DEFAULT_SAFE_HIDDEN_ROOT_FILES],
  };
}

function mergePolicyRecoveryConfig(
  base: PolicyRecoveryConfig,
  override: PolicyRecoveryFileConfig | null,
): PolicyRecoveryConfig {
  if (!override) {
    return base;
  }

  const overrideRules = override.commandDrivenAllowedPathRules?.map((rule) => ({
    pattern: rule.pattern,
    paths: [...rule.paths],
  }));
  const commandDrivenAllowedPathRules = override.replaceDefaultCommandDrivenAllowedPathRules
    ? (overrideRules ?? [])
    : [...base.commandDrivenAllowedPathRules, ...(overrideRules ?? [])];

  return {
    mode: override.mode ?? base.mode,
    commandDrivenAllowedPathRules,
    infraSignalTokens: toUniqueList([
      ...base.infraSignalTokens,
      ...(override.infraSignalTokens ?? []),
    ]),
    safeInfraFileBasenames: toUniqueList([
      ...base.safeInfraFileBasenames,
      ...(override.safeInfraFileBasenames ?? []),
    ]),
    safeInfraFileExtensions: toUniqueList([
      ...base.safeInfraFileExtensions,
      ...(override.safeInfraFileExtensions ?? []),
    ]),
    safeHiddenRootFiles: toUniqueList([
      ...base.safeHiddenRootFiles,
      ...(override.safeHiddenRootFiles ?? []),
    ]),
  };
}

function resolveConfigPath(repoPath: string): string {
  const configured = process.env.POLICY_RECOVERY_CONFIG_PATH?.trim();
  if (!configured) {
    return join(repoPath, ".opentiger/policy-recovery.json");
  }
  if (isAbsolute(configured)) {
    return configured;
  }
  return join(repoPath, configured);
}

async function loadPolicyRecoveryFileConfig(
  repoPath: string,
): Promise<PolicyRecoveryFileConfig | null> {
  const path = resolveConfigPath(repoPath);
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return policyRecoveryFileSchema.parse(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT")) {
      return null;
    }
    console.warn(`[PolicyRecovery] Failed to load ${path}: ${message}`);
    return null;
  }
}

function compileInfraSignalRegex(tokens: string[]): RegExp | null {
  const escaped = tokens
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (escaped.length === 0) {
    return null;
  }
  return new RegExp(`\\b(${escaped.join("|")})\\b`, "i");
}

function isSafePath(path: string): boolean {
  if (!path || path.startsWith("/")) {
    return false;
  }
  if (path.includes("..") || /[*?[\]{}]/.test(path)) {
    return false;
  }
  return true;
}

function isSafeRootLevelPath(path: string, config: PolicyRecoveryConfig): boolean {
  if (!isSafePath(path) || path.includes("/")) {
    return false;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(path)) {
    return false;
  }
  if (!path.startsWith(".")) {
    return true;
  }
  return config.safeHiddenRootFiles.some((allowed) => allowed.toLowerCase() === path.toLowerCase());
}

function isSafeInfraFilePath(path: string, config: PolicyRecoveryConfig): boolean {
  const normalized = normalizePathForMatch(path);
  if (!isSafePath(normalized)) {
    return false;
  }
  const base = normalized.split("/").pop()?.toLowerCase() ?? "";
  if (!base) {
    return false;
  }
  if (config.safeInfraFileBasenames.some((entry) => entry.toLowerCase() === base)) {
    return true;
  }
  return config.safeInfraFileExtensions.some((extension) => base.endsWith(extension.toLowerCase()));
}

function normalizeCommandDrivenRules(
  rules: CommandDrivenAllowedPathRule[],
): CommandDrivenAllowedPathRule[] {
  const normalized: CommandDrivenAllowedPathRule[] = [];
  for (const rule of rules) {
    const pattern = rule.pattern.trim();
    const paths = toUniqueList(rule.paths);
    if (!pattern || paths.length === 0) {
      continue;
    }
    normalized.push({ pattern, paths });
  }
  return normalized;
}

interface CommandDrivenAllowedPathIndex {
  /** Exact file matches (lowercased) */
  exactPaths: Set<string>;
  /** Directory prefix matches (lowercased, guaranteed to end with "/") */
  dirPrefixes: string[];
}

/**
 * Build an index of command-driven allowed paths.
 * Paths ending with "/" are treated as directory prefixes.
 * All other paths are treated as exact file matches.
 */
function buildCommandDrivenAllowedPathIndex(config: PolicyRecoveryConfig): CommandDrivenAllowedPathIndex {
  const exactPaths = new Set<string>();
  const dirPrefixes: string[] = [];
  const seenPrefixes = new Set<string>();

  for (const rule of config.commandDrivenAllowedPathRules) {
    for (const path of rule.paths) {
      const normalized = normalizePathForMatch(path).toLowerCase();
      if (!normalized) continue;

      if (normalized.endsWith("/")) {
        // Explicit directory prefix
        if (!seenPrefixes.has(normalized)) {
          seenPrefixes.add(normalized);
          dirPrefixes.push(normalized);
        }
      } else {
        exactPaths.add(normalized);
      }
    }
  }
  return { exactPaths, dirPrefixes };
}

function matchesCommandDrivenPath(
  normalizedPath: string,
  index: CommandDrivenAllowedPathIndex,
): boolean {
  const lower = normalizedPath.toLowerCase();
  if (index.exactPaths.has(lower)) return true;
  // Match paths under configured directory prefixes (e.g. "target/" matches "target/debug/foo")
  return index.dirPrefixes.some((prefix) => lower.startsWith(prefix));
}

export async function loadPolicyRecoveryConfig(repoPath: string): Promise<PolicyRecoveryConfig> {
  const fromDefaults = getDefaultPolicyRecoveryConfig();
  const fromFile = await loadPolicyRecoveryFileConfig(repoPath);
  const fromEnv = parseEnvJsonConfig();
  const merged = mergePolicyRecoveryConfig(
    mergePolicyRecoveryConfig(fromDefaults, fromFile),
    fromEnv,
  );
  const modeOverride = parseMode(process.env.POLICY_RECOVERY_MODE);

  return {
    ...merged,
    mode: modeOverride ?? merged.mode,
    commandDrivenAllowedPathRules: normalizeCommandDrivenRules(
      merged.commandDrivenAllowedPathRules,
    ),
    infraSignalTokens: toUniqueList(merged.infraSignalTokens),
    safeInfraFileBasenames: toUniqueList(merged.safeInfraFileBasenames).map((entry) =>
      entry.toLowerCase(),
    ),
    safeInfraFileExtensions: toUniqueList(merged.safeInfraFileExtensions).map((entry) => {
      const normalized = entry.startsWith(".") ? entry : `.${entry}`;
      return normalized.toLowerCase();
    }),
    safeHiddenRootFiles: toUniqueList(merged.safeHiddenRootFiles),
  };
}

export function normalizePathForMatch(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .trim();
}

export function mergeUniquePaths(current: string[], extraPaths: string[]): string[] {
  if (extraPaths.length === 0) {
    return current;
  }
  const seen = new Set(current);
  const next = [...current];
  for (const path of extraPaths) {
    if (!seen.has(path)) {
      seen.add(path);
      next.push(path);
    }
  }
  return next;
}

export function extractPolicyViolationPaths(violations: string[]): string[] {
  const paths = new Set<string>();
  for (const violation of violations) {
    const markerIndex = violation.indexOf(":");
    if (markerIndex === -1) {
      continue;
    }
    const rawPath = violation.slice(markerIndex + 1).trim();
    if (!rawPath) {
      continue;
    }
    const normalized =
      (rawPath.startsWith('"') && rawPath.endsWith('"')) ||
      (rawPath.startsWith("'") && rawPath.endsWith("'"))
        ? rawPath.slice(1, -1)
        : rawPath;
    if (normalized.length > 0) {
      paths.add(normalizePathForMatch(normalized));
    }
  }
  return Array.from(paths);
}

export function extractOutsideAllowedViolationPaths(
  source: string[] | string | null | undefined,
): string[] {
  if (Array.isArray(source)) {
    return extractPolicyViolationPaths(
      source.filter((violation) => /^change outside allowed paths:/i.test(violation.trim())),
    );
  }

  const raw = source ?? "";
  if (!raw.trim()) {
    return [];
  }
  const matches = raw.matchAll(
    /change outside allowed paths:\s*(.+?)(?=(?:,\s*change outside allowed paths:)|$|\n)/gi,
  );
  const paths = new Set<string>();
  for (const match of matches) {
    const captured = match[1]?.trim();
    if (!captured) {
      continue;
    }
    const normalized =
      (captured.startsWith('"') && captured.endsWith('"')) ||
      (captured.startsWith("'") && captured.endsWith("'"))
        ? captured.slice(1, -1)
        : captured;
    if (normalized.length > 0) {
      paths.add(normalizePathForMatch(normalized));
    }
  }
  return Array.from(paths);
}

export function extractContextFiles(context: unknown): Set<string> {
  if (!context || typeof context !== "object") {
    return new Set();
  }
  const rawFiles = (context as { files?: unknown }).files;
  if (!Array.isArray(rawFiles)) {
    return new Set();
  }
  const files = rawFiles
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => normalizePathForMatch(entry))
    .filter((entry) => entry.length > 0);
  return new Set(files);
}

function hasBuildOrInfraSignal(
  task: { title: string; goal: string; commands: string[] | null | undefined },
  config: PolicyRecoveryConfig,
): boolean {
  const signalRegex = compileInfraSignalRegex(config.infraSignalTokens);
  if (!signalRegex) {
    return false;
  }
  const signalText = [task.title, task.goal, ...(task.commands ?? [])].join(" ").toLowerCase();
  return signalRegex.test(signalText);
}

function compileCommandRule(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

export function resolveCommandDrivenAllowedPaths(
  task: { commands: string[] | null | undefined; role?: string | null },
  config: PolicyRecoveryConfig,
): string[] {
  if (task.role === "docser") {
    return [];
  }

  const extra = new Set<string>();
  const compiledRules = config.commandDrivenAllowedPathRules
    .map((rule) => ({
      regex: compileCommandRule(rule.pattern),
      paths: rule.paths,
    }))
    .filter((rule): rule is { regex: RegExp; paths: string[] } => Boolean(rule.regex));

  for (const command of task.commands ?? []) {
    for (const rule of compiledRules) {
      if (!rule.regex.test(command)) {
        continue;
      }
      for (const path of rule.paths) {
        extra.add(path);
      }
    }
  }
  return Array.from(extra);
}

export function resolvePolicyViolationAutoAllowPaths(
  task: {
    title: string;
    goal: string;
    commands: string[] | null | undefined;
    context?: unknown;
    role?: string | null;
  },
  outsidePaths: string[],
  config: PolicyRecoveryConfig,
): string[] {
  if (task.role === "docser" || outsidePaths.length === 0) {
    return [];
  }

  const contextFiles = extractContextFiles(task.context);
  const infraTask = hasBuildOrInfraSignal(task, config);
  const allowRootLevelOnInfraTask = config.mode === "aggressive";
  const allowInfraFilesOnInfraTask = config.mode !== "conservative";
  const allowCommandDrivenPathsInAggressiveMode = config.mode === "aggressive";
  const commandDrivenIndex = buildCommandDrivenAllowedPathIndex(config);
  const candidates: string[] = [];

  for (const path of outsidePaths) {
    const normalizedPath = normalizePathForMatch(path);
    if (!normalizedPath) {
      continue;
    }
    if (contextFiles.has(normalizedPath)) {
      candidates.push(path);
      continue;
    }
    if (
      allowCommandDrivenPathsInAggressiveMode &&
      isSafePath(normalizedPath) &&
      matchesCommandDrivenPath(normalizedPath, commandDrivenIndex)
    ) {
      candidates.push(path);
      continue;
    }
    if (!infraTask) {
      continue;
    }
    if (allowInfraFilesOnInfraTask && isSafeInfraFilePath(path, config)) {
      candidates.push(path);
      continue;
    }
    if (allowRootLevelOnInfraTask && isSafeRootLevelPath(path, config)) {
      candidates.push(path);
    }
  }

  return candidates;
}
