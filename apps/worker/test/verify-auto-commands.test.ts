import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runOpenCodeMock, buildOpenCodeEnvMock } = vi.hoisted(() => ({
  runOpenCodeMock: vi.fn(),
  buildOpenCodeEnvMock: vi.fn(async () => ({})),
}));

vi.mock("@openTiger/llm", () => ({
  runOpenCode: runOpenCodeMock,
}));

vi.mock("../src/env", () => ({
  buildOpenCodeEnv: buildOpenCodeEnvMock,
}));

import { resolveAutoVerificationCommands } from "../src/steps/verify/repo-scripts";

const ENV_KEYS = [
  "WORKER_AUTO_VERIFY_MODE",
  "WORKER_AUTO_VERIFY_MAX_COMMANDS",
  "WORKER_VERIFY_CONTRACT_PATH",
  "WORKER_VERIFY_PLAN_PARSE_RETRIES",
  "WORKER_VERIFY_PLAN_TIMEOUT_SECONDS",
  "WORKER_VERIFY_RECONCILE_TIMEOUT_SECONDS",
  "WORKER_VERIFY_PLAN_MODEL",
  "WORKER_MODEL",
  "OPENCODE_MODEL",
  "AGENT_ROLE",
] as const;

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
  (typeof ENV_KEYS)[number],
  string | undefined
>;

const createdRepos: string[] = [];

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

async function createTempRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), "opentiger-worker-verify-"));
  createdRepos.push(repoPath);
  return repoPath;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

beforeEach(() => {
  runOpenCodeMock.mockReset();
  buildOpenCodeEnvMock.mockClear();
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }

  while (createdRepos.length > 0) {
    const repoPath = createdRepos.pop();
    if (!repoPath) {
      continue;
    }
    await rm(repoPath, { recursive: true, force: true });
  }
});

describe("resolveAutoVerificationCommands", () => {
  it("uses contract commands when contract mode is enabled", async () => {
    const repoPath = await createTempRepo();
    await mkdir(join(repoPath, ".opentiger"), { recursive: true });
    await writeJson(join(repoPath, ".opentiger", "verify.contract.json"), {
      commands: ["runner verify:root"],
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

    process.env.WORKER_AUTO_VERIFY_MODE = "contract";
    process.env.AGENT_ROLE = "worker";

    const commands = await resolveAutoVerificationCommands({
      repoPath,
      changedFiles: ["apps/api/src/index.ts"],
      explicitCommands: [],
    });

    expect(commands).toEqual(["runner verify:root", "runner verify:worker", "runner verify:api"]);
    expect(runOpenCodeMock).not.toHaveBeenCalled();
  });

  it("uses llm generated commands in llm mode", async () => {
    const repoPath = await createTempRepo();
    await writeJson(join(repoPath, "package.json"), {
      name: "repo",
      scripts: {
        verify: "runner verify",
      },
    });

    process.env.WORKER_AUTO_VERIFY_MODE = "llm";
    runOpenCodeMock.mockResolvedValueOnce(
      createLlmResult('```json\n{"commands":["runner verify:llm"],"summary":"ok"}\n```'),
    );

    const commands = await resolveAutoVerificationCommands({
      repoPath,
      changedFiles: ["src/app.ts"],
      explicitCommands: [],
    });

    expect(commands).toEqual(["runner verify:llm"]);
    expect(runOpenCodeMock).toHaveBeenCalledTimes(1);
    expect(buildOpenCodeEnvMock).toHaveBeenCalledWith(repoPath);
  });

  it("reconciles multiple invalid llm outputs", async () => {
    const repoPath = await createTempRepo();
    await writeJson(join(repoPath, "package.json"), {
      name: "repo",
      scripts: {
        verify: "runner verify",
      },
    });

    process.env.WORKER_AUTO_VERIFY_MODE = "llm";
    process.env.WORKER_VERIFY_PLAN_PARSE_RETRIES = "1";

    runOpenCodeMock
      .mockResolvedValueOnce(createLlmResult("not-json"))
      .mockResolvedValueOnce(createLlmResult("still not json"))
      .mockResolvedValueOnce(
        createLlmResult('{"commands":["runner verify:reconcile"],"summary":"reconciled"}'),
      );

    const commands = await resolveAutoVerificationCommands({
      repoPath,
      changedFiles: ["src/app.ts"],
      explicitCommands: [],
    });

    expect(commands).toEqual(["runner verify:reconcile"]);
    expect(runOpenCodeMock).toHaveBeenCalledTimes(3);
  });

  it("returns no auto commands in fallback mode when explicit commands already exist", async () => {
    const repoPath = await createTempRepo();
    await writeJson(join(repoPath, "package.json"), {
      name: "repo",
      scripts: {
        verify: "runner verify",
      },
    });

    process.env.WORKER_AUTO_VERIFY_MODE = "fallback";

    const commands = await resolveAutoVerificationCommands({
      repoPath,
      changedFiles: ["src/app.ts"],
      explicitCommands: ["runner verify:explicit"],
    });

    expect(commands).toEqual([]);
    expect(runOpenCodeMock).not.toHaveBeenCalled();
  });
});
