import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OpenCodeOptions, OpenCodeResult } from "../opencode/opencode-types";
import { buildOpenCodePrompt } from "../opencode/opencode-prompt";
import { parseBooleanEnvValue, readRuntimeEnv } from "../opencode/opencode-env";
import { CODEX_DEFAULT_MODEL, CODEX_DEFAULT_SKIP_GIT_REPO_CHECK } from "./codex-constants";
import { normalizeCodexModel } from "./codex-helpers";
import { parseCodexJsonl } from "./parse";

function resolveCodexModel(options: OpenCodeOptions): string {
  const configuredModel = normalizeCodexModel(readRuntimeEnv(options, "CODEX_MODEL"));
  if (configuredModel) {
    return configuredModel;
  }
  return normalizeCodexModel(options.model) ?? CODEX_DEFAULT_MODEL;
}

function resolveEchoStdout(options: OpenCodeOptions): boolean {
  const fromRuntime = readRuntimeEnv(options, "CODEX_ECHO_STDOUT");
  return parseBooleanEnvValue(fromRuntime, true);
}

function resolveSkipGitRepoCheck(options: OpenCodeOptions): boolean {
  const fromRuntime = readRuntimeEnv(options, "CODEX_SKIP_GIT_REPO_CHECK");
  return parseBooleanEnvValue(fromRuntime, CODEX_DEFAULT_SKIP_GIT_REPO_CHECK);
}

export async function executeCodexOnce(
  options: OpenCodeOptions,
): Promise<Omit<OpenCodeResult, "retryCount">> {
  const startTime = Date.now();
  const prompt = await buildOpenCodePrompt(options);
  const model = resolveCodexModel(options);
  const echoStdout = resolveEchoStdout(options);
  const skipGitRepoCheck = resolveSkipGitRepoCheck(options);
  const tempDir = await mkdtemp(join(options.workdir, ".openTiger-codex-"));
  const outputLastMessagePath = join(tempDir, "last-message.txt");
  const inputPromptPath = join(tempDir, "prompt.txt");
  await writeFile(inputPromptPath, prompt, "utf-8");

  const args = ["exec", "--json", "--output-last-message", outputLastMessagePath];
  if (skipGitRepoCheck) {
    args.push("--skip-git-repo-check");
  }
  if (model) {
    args.push("--model", model);
  }
  args.push("-");

  const baseEnv = options.inheritEnv === false ? {} : globalThis.process.env;
  const useProcessGroup = process.platform !== "win32";
  const childProcess = spawn("codex", args, {
    cwd: options.workdir,
    env: {
      ...baseEnv,
      ...options.env,
    },
    detached: useProcessGroup,
    stdio: ["pipe", "pipe", "pipe"],
  });

  childProcess.stdin.write(prompt);
  childProcess.stdin.end();

  const timeoutMs = options.timeoutSeconds * 1000;
  let timedOut = false;
  const terminate = (signal: NodeJS.Signals): void => {
    const pid = childProcess.pid;
    if (!pid) {
      try {
        childProcess.kill(signal);
      } catch {
        // Ignore if already terminated
      }
      return;
    }
    if (useProcessGroup) {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // fallback below
      }
    }
    try {
      process.kill(pid, signal);
    } catch {
      // Ignore if already terminated
    }
  };

  const timeout = setTimeout(() => {
    timedOut = true;
    terminate("SIGTERM");
    setTimeout(() => terminate("SIGKILL"), 2000);
  }, timeoutMs);

  let stdout = "";
  let stderr = "";
  childProcess.stdout.on("data", (data: Buffer) => {
    const chunk = data.toString();
    stdout += chunk;
    if (echoStdout) {
      process.stdout.write(chunk);
    }
  });
  childProcess.stderr.on("data", (data: Buffer) => {
    const chunk = data.toString();
    stderr += chunk;
    process.stderr.write(chunk);
  });

  return await new Promise((resolve) => {
    const settle = async (result: Omit<OpenCodeResult, "retryCount">): Promise<void> => {
      clearTimeout(timeout);
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      resolve(result);
    };

    childProcess.on("close", async (code, signal) => {
      const durationMs = Date.now() - startTime;
      if (signal) {
        stderr += `\n[Codex] Process exited by signal: ${signal}`;
      }
      if (timedOut) {
        stderr += "\n[Codex] Timeout exceeded";
      }

      const parsed = parseCodexJsonl(stdout);
      const outputLastMessage = await readFile(outputLastMessagePath, "utf-8").catch(() => "");
      const stdoutText = outputLastMessage.trim() || parsed.assistantText || stdout;
      const stderrParts = [...parsed.errors];
      if (stderr.trim().length > 0) {
        stderrParts.push(stderr.trim());
      }
      const stderrText = stderrParts.join("\n").trim();
      const success = !parsed.isError && (code ?? 1) === 0;

      await settle({
        success,
        exitCode: success ? 0 : (code ?? -1),
        stdout: stdoutText,
        stderr: stderrText || (success ? "" : "Codex execution failed"),
        durationMs,
        tokenUsage: parsed.tokenUsage
          ? {
              inputTokens: parsed.tokenUsage.inputTokens,
              outputTokens: parsed.tokenUsage.outputTokens,
              totalTokens: parsed.tokenUsage.totalTokens,
            }
          : undefined,
      });
    });

    childProcess.on("error", async (error) => {
      await settle({
        success: false,
        exitCode: -1,
        stdout,
        stderr: `${stderr}\n${error instanceof Error ? error.message : String(error)}`.trim(),
        durationMs: Date.now() - startTime,
      });
    });
  });
}
