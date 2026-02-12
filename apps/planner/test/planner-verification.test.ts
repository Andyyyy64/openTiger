import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runOpenCodeMock } = vi.hoisted(() => ({
  runOpenCodeMock: vi.fn(),
}));

vi.mock("@openTiger/llm", () => ({
  runOpenCode: runOpenCodeMock,
}));

import { augmentVerificationCommandsForTasks } from "../src/planner-verification";
import type { Requirement } from "../src/parser";
import type { TaskGenerationResult } from "../src/strategies";

const ENV_KEYS = [
  "PLANNER_VERIFY_COMMAND_MODE",
  "PLANNER_VERIFY_MAX_COMMANDS",
  "PLANNER_VERIFY_CONTRACT_PATH",
  "PLANNER_VERIFY_PLAN_TIMEOUT_SECONDS",
  "PLANNER_TASK_PARSE_REGEN_RETRIES",
  "PLANNER_TASK_PARSE_RECONCILE_TIMEOUT_SECONDS",
  "PLANNER_MODEL",
] as const;

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
  (typeof ENV_KEYS)[number],
  string | undefined
>;

const tempDirs: string[] = [];

const baseRequirement: Requirement = {
  goal: "予約システムを実装する",
  background: "",
  constraints: [],
  acceptanceCriteria: ["予約作成", "予約更新", "予約取消"],
  scope: {
    inScope: ["apps/**"],
    outOfScope: [],
  },
  allowedPaths: ["apps/**", "packages/**"],
  riskAssessment: [],
  notes: "",
};

function createTaskResult(commands: string[] = []): TaskGenerationResult {
  return {
    tasks: [
      {
        title: "予約更新機能の実装",
        goal: "更新APIが成功し、整合性が保たれる",
        role: "worker",
        context: {
          files: ["apps/api/src/routes/reservations.ts"],
        },
        allowedPaths: ["apps/api/**"],
        commands,
        priority: 50,
        riskLevel: "medium",
        dependencies: [],
        timeboxMinutes: 60,
        targetArea: undefined,
        touches: [],
      },
    ],
    warnings: [],
    totalEstimatedMinutes: 60,
  };
}

function createLlmResult(stdout: string) {
  return {
    success: true,
    exitCode: 0,
    stdout,
    stderr: "",
    durationMs: 1,
    retryCount: 0,
  };
}

async function createWorkdir(): Promise<string> {
  const workdir = await mkdtemp(join(tmpdir(), "opentiger-planner-verify-"));
  tempDirs.push(workdir);
  return workdir;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

beforeEach(() => {
  runOpenCodeMock.mockReset();
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

describe("augmentVerificationCommandsForTasks", () => {
  it("fills commands from verify.contract in contract mode", async () => {
    const workdir = await createWorkdir();
    await mkdir(join(workdir, ".opentiger"), { recursive: true });
    await writeJson(join(workdir, ".opentiger", "verify.contract.json"), {
      commands: ["runner verify:base"],
      byRole: {
        worker: ["runner verify:worker"],
      },
      rules: [
        {
          whenChangedAny: ["apps/api/**"],
          commands: ["runner verify:api"],
        },
      ],
    });

    process.env.PLANNER_VERIFY_COMMAND_MODE = "contract";

    const result = await augmentVerificationCommandsForTasks({
      workdir,
      requirement: baseRequirement,
      result: createTaskResult([]),
    });

    expect(result.tasks[0]?.commands).toEqual([
      "runner verify:base",
      "runner verify:worker",
      "runner verify:api",
    ]);
    expect(runOpenCodeMock).not.toHaveBeenCalled();
  });

  it("fills commands from llm when contract is unavailable", async () => {
    const workdir = await createWorkdir();
    await writeJson(join(workdir, "package.json"), {
      name: "repo",
      scripts: {
        verify: "runner verify",
      },
    });

    process.env.PLANNER_VERIFY_COMMAND_MODE = "llm";
    runOpenCodeMock.mockResolvedValueOnce(
      createLlmResult('{"commands":["runner verify:llm"],"warnings":[]}'),
    );

    const result = await augmentVerificationCommandsForTasks({
      workdir,
      requirement: baseRequirement,
      result: createTaskResult([]),
    });

    expect(result.tasks[0]?.commands).toEqual(["runner verify:llm"]);
    expect(runOpenCodeMock).toHaveBeenCalledTimes(1);
  });

  it("keeps existing commands in fallback mode", async () => {
    const workdir = await createWorkdir();
    await writeJson(join(workdir, "package.json"), { name: "repo" });
    process.env.PLANNER_VERIFY_COMMAND_MODE = "fallback";

    const result = await augmentVerificationCommandsForTasks({
      workdir,
      requirement: baseRequirement,
      result: createTaskResult(["runner verify:existing"]),
    });

    expect(result.tasks[0]?.commands).toEqual(["runner verify:existing"]);
    expect(runOpenCodeMock).not.toHaveBeenCalled();
  });

  it("adds warning when commands stay unresolved", async () => {
    const workdir = await createWorkdir();
    await writeJson(join(workdir, "package.json"), { name: "repo" });
    process.env.PLANNER_VERIFY_COMMAND_MODE = "contract";

    const result = await augmentVerificationCommandsForTasks({
      workdir,
      requirement: baseRequirement,
      result: createTaskResult([]),
    });

    expect(result.tasks[0]?.commands).toEqual([]);
    expect(
      result.warnings.some((warning) => warning.includes("verification commands unresolved")),
    ).toBe(true);
  });
});
