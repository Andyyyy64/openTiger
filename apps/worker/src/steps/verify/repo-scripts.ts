import { access, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { runOpenCode } from "@openTiger/llm";
import { buildOpenCodeEnv } from "../../env";
import { matchDeniedCommand } from "./command-normalizer";
import { parseCommand } from "./command-parser";
import { matchesPattern, normalizePathForMatch } from "./paths";

export async function loadRootScripts(repoPath: string): Promise<Record<string, string>> {
  try {
    const content = await readFile(join(repoPath, "package.json"), "utf-8");
    const parsed = JSON.parse(content) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}

type PackageManifest = {
  dir: string;
  name?: string;
  scripts: Record<string, string>;
};

type ResolveAutoVerificationCommandsOptions = {
  repoPath: string;
  changedFiles: string[];
  explicitCommands: string[];
  deniedCommands?: string[];
};

type VerificationContractRule = {
  whenChangedAny?: string[];
  whenChangedAll?: string[];
  commands: string[];
};

type VerificationContract = {
  commands?: string[];
  byRole?: Record<string, string[]>;
  rules?: VerificationContractRule[];
};

type VerificationPlan = {
  commands: string[];
  summary?: string;
};

const DEFAULT_VERIFY_CONTRACT_PATH = ".opentiger/verify.contract.json";
const DEFAULT_AUTO_VERIFY_MAX_COMMANDS = 4;
const DEFAULT_VERIFY_PLAN_TIMEOUT_SECONDS = 120;
const DEFAULT_VERIFY_PLAN_PARSE_RETRIES = 2;
const DEFAULT_VERIFY_RECONCILE_TIMEOUT_SECONDS = 180;
const MAX_PROMPT_PREVIEW_CHARS = 6000;
const MAX_CONTEXT_PACKAGES = 16;
const MAX_CONTEXT_SCRIPTS_PER_PACKAGE = 20;
const MAX_CONTEXT_SCRIPT_BODY_CHARS = 180;
const ANSI_ESCAPE_SEQUENCE = `${String.fromCharCode(27)}\\[[0-9;]*m`;
const ANSI_ESCAPE_REGEX = new RegExp(ANSI_ESCAPE_SEQUENCE, "g");
const CONTROL_CHARS_CLASS = `${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}${String.fromCharCode(12)}${String.fromCharCode(14)}-${String.fromCharCode(31)}${String.fromCharCode(127)}`;
const CONTROL_CHARS_REGEX = new RegExp(`[${CONTROL_CHARS_CLASS}]+`, "g");

type AutoVerifyMode = "off" | "fallback" | "contract" | "llm" | "hybrid";

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function resolveAutoVerifyMode(raw: string | undefined): AutoVerifyMode {
  const normalized = (raw ?? "hybrid").trim().toLowerCase();
  if (normalized === "off" || normalized === "disabled") {
    return "off";
  }
  if (normalized === "fallback" || normalized === "safety") {
    return "fallback";
  }
  if (normalized === "contract") {
    return "contract";
  }
  if (normalized === "llm") {
    return "llm";
  }
  return "hybrid";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function normalizeScriptsForPrompt(
  scripts: Record<string, string>,
  maxEntries = MAX_CONTEXT_SCRIPTS_PER_PACKAGE,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  const entries = Object.entries(scripts)
    .map(([name, command]) => [name, command.trim()] as const)
    .filter(([, command]) => command.length > 0)
    .slice(0, maxEntries);

  for (const [name, command] of entries) {
    normalized[name] = command.slice(0, MAX_CONTEXT_SCRIPT_BODY_CHARS);
  }

  return normalized;
}

async function loadPackageManifest(packageJsonPath: string): Promise<PackageManifest | null> {
  try {
    const content = await readFile(packageJsonPath, "utf-8");
    const parsed = JSON.parse(content) as {
      name?: string;
      scripts?: Record<string, string>;
    };
    return {
      dir: dirname(packageJsonPath),
      name: typeof parsed.name === "string" ? parsed.name : undefined,
      scripts: parsed.scripts ?? {},
    };
  } catch {
    return null;
  }
}

function isInsideRepo(repoRoot: string, candidatePath: string): boolean {
  const normalizedRoot = resolve(repoRoot);
  const normalizedCandidate = resolve(candidatePath);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}/`) ||
    normalizedCandidate.startsWith(`${normalizedRoot}\\`)
  );
}

async function findNearestPackageManifest(
  repoPath: string,
  changedFile: string,
): Promise<PackageManifest | null> {
  const normalizedFile = normalizePathForMatch(changedFile);
  let current = resolve(repoPath, normalizedFile);
  if (!isInsideRepo(repoPath, current)) {
    return null;
  }

  current = dirname(current);

  while (isInsideRepo(repoPath, current)) {
    const manifest = await loadPackageManifest(join(current, "package.json"));
    if (manifest) {
      return manifest;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return null;
}

async function collectChangedPackageManifests(
  repoPath: string,
  changedFiles: string[],
): Promise<PackageManifest[]> {
  const packageManifestMap = new Map<string, PackageManifest>();

  for (const changedFile of changedFiles) {
    const manifest = await findNearestPackageManifest(repoPath, changedFile);
    if (!manifest) {
      continue;
    }
    packageManifestMap.set(manifest.dir, manifest);
  }

  return Array.from(packageManifestMap.values()).slice(0, MAX_CONTEXT_PACKAGES);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isVerificationContract(value: unknown): value is VerificationContract {
  if (!isRecord(value)) {
    return false;
  }
  const hasCommands = value.commands === undefined || Array.isArray(value.commands);
  const hasByRole = value.byRole === undefined || isRecord(value.byRole);
  const hasRules = value.rules === undefined || Array.isArray(value.rules);
  return hasCommands && hasByRole && hasRules;
}

async function loadVerificationContract(repoPath: string): Promise<VerificationContract | null> {
  const relativePath =
    process.env.WORKER_VERIFY_CONTRACT_PATH?.trim() || DEFAULT_VERIFY_CONTRACT_PATH;
  const contractPath = join(repoPath, relativePath);

  if (!(await pathExists(contractPath))) {
    return null;
  }

  try {
    const raw = await readFile(contractPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return isVerificationContract(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function roleFromEnvironment(): string {
  const role = process.env.AGENT_ROLE?.trim().toLowerCase();
  return role || "worker";
}

function ruleMatchesChangedFiles(rule: VerificationContractRule, changedFiles: string[]): boolean {
  const whenChangedAny = toStringArray(rule.whenChangedAny);
  const whenChangedAll = toStringArray(rule.whenChangedAll);

  const anyMatched =
    whenChangedAny.length === 0 ||
    changedFiles.some((file) => matchesPattern(file, whenChangedAny));

  const allMatched = whenChangedAll.every((pattern) =>
    changedFiles.some((file) => matchesPattern(file, [pattern])),
  );

  return anyMatched && allMatched;
}

function resolveContractCommands(
  contract: VerificationContract,
  changedFiles: string[],
  role: string,
): string[] {
  const commands: string[] = [];

  commands.push(...toStringArray(contract.commands));

  if (isRecord(contract.byRole)) {
    commands.push(...toStringArray(contract.byRole[role]));
  }

  if (Array.isArray(contract.rules)) {
    for (const rawRule of contract.rules) {
      if (!isRecord(rawRule)) {
        continue;
      }
      const rule: VerificationContractRule = {
        whenChangedAny: toStringArray(rawRule.whenChangedAny),
        whenChangedAll: toStringArray(rawRule.whenChangedAll),
        commands: toStringArray(rawRule.commands),
      };
      if (rule.commands.length === 0) {
        continue;
      }
      if (!ruleMatchesChangedFiles(rule, changedFiles)) {
        continue;
      }
      commands.push(...rule.commands);
    }
  }

  return commands;
}

function stripControlChars(text: string): string {
  return text.replace(ANSI_ESCAPE_REGEX, "").replace(CONTROL_CHARS_REGEX, "");
}

function extractCodeBlockCandidates(text: string): string[] {
  const candidates: string[] = [];
  const pattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of text.matchAll(pattern)) {
    const value = match[1]?.trim();
    if (value) {
      candidates.push(value);
    }
  }
  return candidates;
}

function extractBalancedObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaping = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (!ch) {
      continue;
    }

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (ch === "\\") {
        escaping = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
      continue;
    }

    if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const value = text.slice(start, i + 1).trim();
        if (value) {
          candidates.push(value);
        }
        start = -1;
      }
    }
  }

  return candidates;
}

function collectJsonCandidates(text: string): string[] {
  const normalized = stripControlChars(text);
  const ordered = [
    ...extractCodeBlockCandidates(normalized),
    ...extractBalancedObjectCandidates(normalized),
    normalized.trim(),
  ];

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const candidate of ordered) {
    const value = candidate.trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    unique.push(value);
  }

  return unique;
}

function isVerificationPlan(value: unknown): value is VerificationPlan {
  if (!isRecord(value)) {
    return false;
  }
  return Array.isArray(value.commands);
}

function extractVerificationPlan(text: string): VerificationPlan {
  const candidates = collectJsonCandidates(text);
  const parseErrors: string[] = [];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!isVerificationPlan(parsed)) {
        continue;
      }
      const commands = toStringArray(parsed.commands);
      const summary = typeof parsed.summary === "string" ? parsed.summary : undefined;
      return { commands, summary };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      parseErrors.push(message);
    }
  }

  const hint = parseErrors.length > 0 ? ` (parse errors: ${parseErrors[0]})` : "";
  throw new Error(`No valid verification plan JSON found${hint}`);
}

function clipOutput(text: string): string {
  return stripControlChars(text).slice(0, MAX_PROMPT_PREVIEW_CHARS);
}

function buildRegenerationPrompt(basePrompt: string, previousOutput: string): string {
  return `${basePrompt}

## Regeneration Instruction
Your previous response was not parseable JSON.
Regenerate and output JSON only.

Previous response:
\`\`\`
${clipOutput(previousOutput)}
\`\`\``;
}

function buildReconcilePrompt(basePrompt: string, outputs: string[]): string {
  const candidates = outputs
    .slice(0, 3)
    .map(
      (output, index) => `Candidate ${index + 1}:
\`\`\`
${clipOutput(output)}
\`\`\``,
    )
    .join("\n\n");

  return `${basePrompt}

## Reconciliation Instruction
Multiple attempts failed JSON parsing.
Reconcile the candidates and output exactly one valid JSON object.
Do not add markdown fences.

${candidates}`;
}

function dedupeCommands(commands: string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const command of commands) {
    const trimmed = command.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

function sanitizeCommands(params: {
  commands: string[];
  deniedCommands: string[];
  explicitCommands: string[];
  maxCommands: number;
}): string[] {
  const explicitSet = new Set(params.explicitCommands.map((command) => command.trim()));
  const accepted: string[] = [];

  for (const command of dedupeCommands(params.commands)) {
    if (explicitSet.has(command)) {
      continue;
    }
    if (!parseCommand(command)) {
      continue;
    }
    if (matchDeniedCommand(command, params.deniedCommands)) {
      continue;
    }
    accepted.push(command);
    if (accepted.length >= params.maxCommands) {
      break;
    }
  }

  return accepted;
}

function buildPlannerPrompt(params: {
  changedFiles: string[];
  explicitCommands: string[];
  rootScripts: Record<string, string>;
  changedPackages: Array<{
    packageName: string;
    packagePath: string;
    scripts: Record<string, string>;
  }>;
  deniedCommands: string[];
  maxCommands: number;
}): string {
  const payload = {
    changedFiles: params.changedFiles,
    explicitCommands: params.explicitCommands,
    deniedCommandPatterns: params.deniedCommands,
    rootScripts: normalizeScriptsForPrompt(params.rootScripts),
    changedPackages: params.changedPackages,
  };

  return [
    "You are a verification command planner for a software repository.",
    "Return one JSON object with this schema:",
    '{"commands": ["string"], "summary": "string"}',
    "Rules:",
    "- Output JSON only.",
    "- commands must be non-interactive and deterministic.",
    "- Do not use shell control operators.",
    "- Prefer repository-defined scripts from the provided context.",
    "- Provide only supplemental commands (explicitCommands already exist).",
    `- Maximum commands: ${params.maxCommands}`,
    "- If no additional commands are needed, return commands as an empty array.",
    "Repository context:",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n");
}

async function generateCommandsWithLlm(params: {
  repoPath: string;
  changedFiles: string[];
  explicitCommands: string[];
  deniedCommands: string[];
  maxCommands: number;
}): Promise<string[]> {
  const rootScripts = await loadRootScripts(params.repoPath);
  const changedManifests = await collectChangedPackageManifests(params.repoPath, params.changedFiles);
  const changedPackages = changedManifests.map((manifest) => ({
    packageName: manifest.name ?? "(unnamed)",
    packagePath: normalizePathForMatch(relative(params.repoPath, manifest.dir)) || ".",
    scripts: normalizeScriptsForPrompt(manifest.scripts),
  }));

  const basePrompt = buildPlannerPrompt({
    changedFiles: params.changedFiles,
    explicitCommands: params.explicitCommands,
    rootScripts,
    changedPackages,
    deniedCommands: params.deniedCommands,
    maxCommands: params.maxCommands,
  });

  const retries = parseNonNegativeInt(
    process.env.WORKER_VERIFY_PLAN_PARSE_RETRIES,
    DEFAULT_VERIFY_PLAN_PARSE_RETRIES,
  );
  const timeoutSeconds = parsePositiveInt(
    process.env.WORKER_VERIFY_PLAN_TIMEOUT_SECONDS,
    DEFAULT_VERIFY_PLAN_TIMEOUT_SECONDS,
  );
  const reconcileTimeoutSeconds = parsePositiveInt(
    process.env.WORKER_VERIFY_RECONCILE_TIMEOUT_SECONDS,
    DEFAULT_VERIFY_RECONCILE_TIMEOUT_SECONDS,
  );
  const model =
    process.env.WORKER_VERIFY_PLAN_MODEL?.trim() ||
    process.env.WORKER_MODEL?.trim() ||
    process.env.OPENCODE_MODEL?.trim() ||
    undefined;

  const env = await buildOpenCodeEnv(params.repoPath);
  const outputs: string[] = [];
  let prompt = basePrompt;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const result = await runOpenCode({
      workdir: params.repoPath,
      task: prompt,
      model,
      timeoutSeconds,
      env,
      inheritEnv: false,
    });

    if (!result.success) {
      throw new Error(`verify-plan generation failed: ${result.stderr}`);
    }

    outputs.push(result.stdout);

    try {
      const plan = extractVerificationPlan(result.stdout);
      return sanitizeCommands({
        commands: plan.commands,
        deniedCommands: params.deniedCommands,
        explicitCommands: params.explicitCommands,
        maxCommands: params.maxCommands,
      });
    } catch {
      if (attempt < retries) {
        prompt = buildRegenerationPrompt(basePrompt, result.stdout);
      }
    }
  }

  if (outputs.length >= 2) {
    const reconcile = await runOpenCode({
      workdir: params.repoPath,
      task: buildReconcilePrompt(basePrompt, outputs),
      model,
      timeoutSeconds: reconcileTimeoutSeconds,
      env,
      inheritEnv: false,
    });

    if (reconcile.success) {
      const plan = extractVerificationPlan(reconcile.stdout);
      return sanitizeCommands({
        commands: plan.commands,
        deniedCommands: params.deniedCommands,
        explicitCommands: params.explicitCommands,
        maxCommands: params.maxCommands,
      });
    }
  }

  throw new Error("verify-plan generation failed: could not parse JSON response");
}

export async function resolveAutoVerificationCommands(
  options: ResolveAutoVerificationCommandsOptions,
): Promise<string[]> {
  const mode = resolveAutoVerifyMode(process.env.WORKER_AUTO_VERIFY_MODE);
  if (mode === "off") {
    return [];
  }

  const maxCommands = parsePositiveInt(
    process.env.WORKER_AUTO_VERIFY_MAX_COMMANDS,
    DEFAULT_AUTO_VERIFY_MAX_COMMANDS,
  );
  const deniedCommands = options.deniedCommands ?? [];
  const role = roleFromEnvironment();

  const contract = await loadVerificationContract(options.repoPath);
  const contractCommands = contract
    ? sanitizeCommands({
        commands: resolveContractCommands(contract, options.changedFiles, role),
        deniedCommands,
        explicitCommands: options.explicitCommands,
        maxCommands,
      })
    : [];

  if (mode === "contract") {
    return contractCommands;
  }

  if (mode === "fallback" && options.explicitCommands.length > 0 && contractCommands.length > 0) {
    return contractCommands.slice(0, maxCommands);
  }

  if (mode === "fallback" && options.explicitCommands.length > 0) {
    return [];
  }

  if (mode === "llm") {
    try {
      return await generateCommandsWithLlm({
        repoPath: options.repoPath,
        changedFiles: options.changedFiles,
        explicitCommands: options.explicitCommands,
        deniedCommands,
        maxCommands,
      });
    } catch (error) {
      console.warn(
        `[Verify] LLM verification command planning failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  try {
    const llmCommands = await generateCommandsWithLlm({
      repoPath: options.repoPath,
      changedFiles: options.changedFiles,
      explicitCommands: options.explicitCommands,
      deniedCommands,
      maxCommands,
    });

    return dedupeCommands([...contractCommands, ...llmCommands]).slice(0, maxCommands);
  } catch (error) {
    console.warn(
      `[Verify] LLM verification command planning failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return contractCommands.slice(0, maxCommands);
  }
}
