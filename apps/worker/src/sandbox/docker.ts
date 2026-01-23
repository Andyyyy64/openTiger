import { spawn } from "node:child_process";

// Docker実行オプション
export interface DockerExecOptions {
  // 使用するDockerイメージ
  image: string;
  // コンテナ内の作業ディレクトリ
  workdir: string;
  // ホスト側のディレクトリをマウント
  mounts?: Array<{
    hostPath: string;
    containerPath: string;
    readonly?: boolean;
  }>;
  // 環境変数
  env?: Record<string, string>;
  // タイムアウト（秒）
  timeoutSeconds?: number;
  // ネットワーク設定
  network?: "none" | "host" | "bridge";
  // メモリ制限（バイト）
  memoryLimit?: number;
  // CPU制限（コア数）
  cpuLimit?: number;
  // ユーザーID（セキュリティ）
  user?: string;
}

// Docker実行結果
export interface DockerExecResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  containerId?: string;
}

// デフォルトのDockerオプション
const DEFAULT_OPTIONS: Partial<DockerExecOptions> = {
  network: "none", // ネットワーク無効化
  memoryLimit: 4 * 1024 * 1024 * 1024, // 4GB
  cpuLimit: 2,
  timeoutSeconds: 3600,
  user: "1001:1001", // 非rootユーザー
};

// 許可された環境変数のリスト
const ALLOWED_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GITHUB_TOKEN",
  "NODE_ENV",
  "DEBUG",
  "LANG",
  "LC_ALL",
  "TZ",
];

// 禁止コマンドのリスト
const FORBIDDEN_COMMANDS = [
  "rm -rf /",
  "chmod",
  "chown",
  "sudo",
  "su",
  "apt",
  "yum",
  "dnf",
  "curl",
  "wget",
];

// 環境変数をフィルタリング（Allowlist方式）
function filterEnvVars(env: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const key of ALLOWED_ENV_VARS) {
    if (env[key]) {
      filtered[key] = env[key];
    }
  }
  return filtered;
}

// コマンドが許可されているかチェック
function isCommandAllowed(command: string[]): boolean {
  const fullCommand = command.join(" ").toLowerCase();
  for (const forbidden of FORBIDDEN_COMMANDS) {
    if (fullCommand.includes(forbidden.toLowerCase())) {
      return false;
    }
  }
  return true;
}

// Dockerコンテナ内でコマンドを実行
export async function runInDocker(
  command: string[],
  options: DockerExecOptions
): Promise<DockerExecResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const startTime = Date.now();

  // コマンドのバリデーション
  if (!isCommandAllowed(command)) {
    return {
      success: false,
      exitCode: -1,
      stdout: "",
      stderr: `Security Error: Command contains forbidden patterns.`,
      durationMs: 0,
    };
  }

  // docker run コマンドを構築
  const dockerArgs: string[] = ["run", "--rm"];

  // ネットワーク設定
  if (opts.network) {
    dockerArgs.push(`--network=${opts.network}`);
  }

  // メモリ制限
  if (opts.memoryLimit) {
    dockerArgs.push(`--memory=${opts.memoryLimit}`);
    dockerArgs.push(`--memory-swap=${opts.memoryLimit}`); // スワップも制限
  }

  // CPU制限
  if (opts.cpuLimit) {
    dockerArgs.push(`--cpus=${opts.cpuLimit}`);
  }

  // ユーザー指定
  if (opts.user) {
    dockerArgs.push(`--user=${opts.user}`);
  }

  // 作業ディレクトリ
  dockerArgs.push(`--workdir=${opts.workdir}`);

  // マウント設定
  if (opts.mounts) {
    for (const mount of opts.mounts) {
      const readonlyFlag = mount.readonly ? ":ro" : "";
      dockerArgs.push(
        `--volume=${mount.hostPath}:${mount.containerPath}${readonlyFlag}`
      );
    }
  }

  // 環境変数
  if (opts.env) {
    const filteredEnv = filterEnvVars(opts.env);
    for (const [key, value] of Object.entries(filteredEnv)) {
      dockerArgs.push(`--env=${key}=${value}`);
    }
  }

  // セキュリティ設定
  dockerArgs.push("--security-opt=no-new-privileges"); // 権限昇格を禁止
  dockerArgs.push("--cap-drop=ALL"); // すべてのcapabilityを削除
  dockerArgs.push("--read-only"); // ルートファイルシステムを読み取り専用に

  // tmpディレクトリは書き込み可能にする
  dockerArgs.push("--tmpfs=/tmp:rw,noexec,nosuid,size=1g");

  // イメージとコマンド
  dockerArgs.push(opts.image);
  dockerArgs.push(...command);

  return new Promise((resolve) => {
    const process = spawn("docker", dockerArgs, {
      timeout: (opts.timeoutSeconds ?? 3600) * 1000,
    });

    let stdout = "";
    let stderr = "";

    process.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    process.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    process.on("close", (code) => {
      resolve({
        success: code === 0,
        exitCode: code ?? -1,
        stdout,
        stderr,
        durationMs: Date.now() - startTime,
      });
    });

    process.on("error", (error) => {
      resolve({
        success: false,
        exitCode: -1,
        stdout,
        stderr: stderr + "\n" + error.message,
        durationMs: Date.now() - startTime,
      });
    });
  });
}

// OpenCode実行用のDocker設定を生成
export function createOpenCodeDockerOptions(
  workspacePath: string,
  env?: Record<string, string>
): DockerExecOptions {
  return {
    image: "h1ve/worker:latest",
    workdir: "/workspace",
    mounts: [
      {
        hostPath: workspacePath,
        containerPath: "/workspace",
        readonly: false,
      },
    ],
    env: {
      // OpenCode用の環境変数
      GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? "",
      // GitHub認証（PR作成用）
      GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? "",
      // 追加の環境変数
      ...env,
    },
    network: "bridge", // OpenCode はAPI通信が必要
    timeoutSeconds: 3600,
    memoryLimit: 4 * 1024 * 1024 * 1024, // 4GB（Gemini FlashならClaudeより軽量）
    cpuLimit: 2,
  };
}

// サンドボックス内でOpenCodeを実行
export async function runOpenCodeInSandbox(
  workspacePath: string,
  task: string,
  instructionsPath?: string,
  additionalEnv?: Record<string, string>
): Promise<DockerExecResult> {
  const options = createOpenCodeDockerOptions(workspacePath, additionalEnv);

  // OpenCode コマンドを構築
  const command = ["opencode", "run", task];

  return runInDocker(command, options);
}

// Dockerイメージが利用可能かチェック
export async function checkDockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const process = spawn("docker", ["info"], { timeout: 10000 });

    process.on("close", (code) => {
      resolve(code === 0);
    });

    process.on("error", () => {
      resolve(false);
    });
  });
}

// 指定したイメージが存在するかチェック
export async function checkImageExists(image: string): Promise<boolean> {
  return new Promise((resolve) => {
    const process = spawn("docker", ["image", "inspect", image], {
      timeout: 10000,
    });

    process.on("close", (code) => {
      resolve(code === 0);
    });

    process.on("error", () => {
      resolve(false);
    });
  });
}
