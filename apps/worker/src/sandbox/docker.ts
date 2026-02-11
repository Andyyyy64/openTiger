import { spawn } from "node:child_process";

// Docker run options
export interface DockerExecOptions {
  // Docker image to use
  image: string;
  // Working directory inside container
  workdir: string;
  // Mount host directories
  mounts?: Array<{
    hostPath: string;
    containerPath: string;
    readonly?: boolean;
  }>;
  // Environment variables
  env?: Record<string, string>;
  // Timeout (seconds)
  timeoutSeconds?: number;
  // Network config
  network?: "none" | "host" | "bridge";
  // Memory limit (bytes)
  memoryLimit?: number;
  // CPU limit (cores)
  cpuLimit?: number;
  // User ID (security)
  user?: string;
}

// Docker run result
export interface DockerExecResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  containerId?: string;
}

// Default Docker options
const DEFAULT_OPTIONS: Partial<DockerExecOptions> = {
  network: "none", // Disable network
  memoryLimit: 4 * 1024 * 1024 * 1024, // 4GB
  cpuLimit: 2,
  timeoutSeconds: 3600,
  user: "1001:1001", // Non-root user
};

// Allowed env vars
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

// Denied commands
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

// Filter environment variables (allowlist approach)
function filterEnvVars(env: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const key of ALLOWED_ENV_VARS) {
    if (env[key]) {
      filtered[key] = env[key];
    }
  }
  return filtered;
}

// Check if command is allowed
function isCommandAllowed(command: string[]): boolean {
  const fullCommand = command.join(" ").toLowerCase();
  for (const forbidden of FORBIDDEN_COMMANDS) {
    if (fullCommand.includes(forbidden.toLowerCase())) {
      return false;
    }
  }
  return true;
}

// Execute command inside Docker container
export async function runInDocker(
  command: string[],
  options: DockerExecOptions,
): Promise<DockerExecResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const startTime = Date.now();

  // Validate command
  if (!isCommandAllowed(command)) {
    return {
      success: false,
      exitCode: -1,
      stdout: "",
      stderr: `Security Error: Command contains forbidden patterns.`,
      durationMs: 0,
    };
  }

  // Build docker run command
  const dockerArgs: string[] = ["run", "--rm"];

  // Network config
  if (opts.network) {
    dockerArgs.push(`--network=${opts.network}`);
  }

  // Memory limit
  if (opts.memoryLimit) {
    dockerArgs.push(`--memory=${opts.memoryLimit}`);
    dockerArgs.push(`--memory-swap=${opts.memoryLimit}`); // Limit swap too
  }

  // CPU limit
  if (opts.cpuLimit) {
    dockerArgs.push(`--cpus=${opts.cpuLimit}`);
  }

  // User override
  if (opts.user) {
    dockerArgs.push(`--user=${opts.user}`);
  }

  // Working directory
  dockerArgs.push(`--workdir=${opts.workdir}`);

  // Mount config
  if (opts.mounts) {
    for (const mount of opts.mounts) {
      const readonlyFlag = mount.readonly ? ":ro" : "";
      dockerArgs.push(`--volume=${mount.hostPath}:${mount.containerPath}${readonlyFlag}`);
    }
  }

  // Environment variables
  if (opts.env) {
    const filteredEnv = filterEnvVars(opts.env);
    for (const [key, value] of Object.entries(filteredEnv)) {
      dockerArgs.push(`--env=${key}=${value}`);
    }
  }

  // Security settings
  dockerArgs.push("--security-opt=no-new-privileges"); // Disable privilege escalation
  dockerArgs.push("--cap-drop=ALL"); // Drop all capabilities
  dockerArgs.push("--read-only"); // Read-only root filesystem

  // Make tmp writable
  dockerArgs.push("--tmpfs=/tmp:rw,noexec,nosuid,size=1g");

  // Image and command
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

// Build Docker config for OpenCode execution
export function createOpenCodeDockerOptions(
  workspacePath: string,
  env?: Record<string, string>,
): DockerExecOptions {
  return {
    image: "openTiger/worker:latest",
    workdir: "/workspace",
    mounts: [
      {
        hostPath: workspacePath,
        containerPath: "/workspace",
        readonly: false,
      },
    ],
    env: {
      // OpenCode env vars
      GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? "",
      // GitHub auth (for PR creation)
      GITHUB_AUTH_MODE: process.env.GITHUB_AUTH_MODE ?? "gh",
      GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? "",
      // Extra env vars
      ...env,
    },
    network: "bridge", // OpenCode requires API communication
    timeoutSeconds: 3600,
    memoryLimit: 4 * 1024 * 1024 * 1024, // 4GB (Gemini Flash is lighter than Claude)
    cpuLimit: 2,
  };
}

// Run OpenCode in sandbox
export async function runOpenCodeInSandbox(
  workspacePath: string,
  task: string,
  instructionsPath?: string,
  additionalEnv?: Record<string, string>,
): Promise<DockerExecResult> {
  const options = createOpenCodeDockerOptions(workspacePath, additionalEnv);

  // Build OpenCode command
  const command = ["opencode", "run", task];

  return runInDocker(command, options);
}

// Check if Docker image is available
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

// Check if specified image exists
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
