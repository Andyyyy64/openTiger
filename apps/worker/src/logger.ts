// 構造化ログ出力モジュール

// ログレベル
export type LogLevel = "debug" | "info" | "warn" | "error";

// ログエントリの構造
export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  taskId?: string;
  runId?: string;
  agentId?: string;
  step?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

// ログ出力設定
export interface LoggerConfig {
  component: string;
  taskId?: string;
  runId?: string;
  agentId?: string;
  minLevel?: LogLevel;
  jsonOutput?: boolean;
}

// ログレベルの優先度
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// 構造化ロガー
export class Logger {
  private config: LoggerConfig;

  constructor(config: LoggerConfig) {
    this.config = {
      minLevel: "info",
      jsonOutput: process.env.LOG_FORMAT === "json",
      ...config,
    };
  }

  // 子ロガーを作成（追加のコンテキストを持つ）
  child(context: Partial<LoggerConfig>): Logger {
    return new Logger({
      ...this.config,
      ...context,
    });
  }

  // ログエントリを出力
  private log(level: LogLevel, message: string, metadata?: Record<string, unknown>): void {
    // ログレベルのフィルタリング
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.config.minLevel ?? "info"]) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component: this.config.component,
      message,
      ...(this.config.taskId && { taskId: this.config.taskId }),
      ...(this.config.runId && { runId: this.config.runId }),
      ...(this.config.agentId && { agentId: this.config.agentId }),
      ...(metadata && { metadata }),
    };

    if (this.config.jsonOutput) {
      // JSON形式で出力
      console.log(JSON.stringify(entry));
    } else {
      // 人間が読みやすい形式で出力
      const prefix = this.formatPrefix(entry);
      const metaStr = metadata ? ` ${JSON.stringify(metadata)}` : "";

      switch (level) {
        case "error":
          console.error(`${prefix} ${message}${metaStr}`);
          break;
        case "warn":
          console.warn(`${prefix} ${message}${metaStr}`);
          break;
        default:
          console.log(`${prefix} ${message}${metaStr}`);
      }
    }
  }

  // プレフィックスをフォーマット
  private formatPrefix(entry: LogEntry): string {
    const time = entry.timestamp.split("T")[1]?.slice(0, 8) ?? "";
    const level = entry.level.toUpperCase().padEnd(5);
    const component = entry.component;
    const context = entry.taskId ? `[${entry.taskId.slice(0, 8)}]` : "";

    return `${time} ${level} [${component}]${context}`;
  }

  // 各ログレベルのメソッド
  debug(message: string, metadata?: Record<string, unknown>): void {
    this.log("debug", message, metadata);
  }

  info(message: string, metadata?: Record<string, unknown>): void {
    this.log("info", message, metadata);
  }

  warn(message: string, metadata?: Record<string, unknown>): void {
    this.log("warn", message, metadata);
  }

  error(message: string, metadata?: Record<string, unknown>): void {
    this.log("error", message, metadata);
  }

  // ステップ開始をログ
  stepStart(step: string, description: string): void {
    this.info(`[${step}] ${description}`, { step, event: "step_start" });
  }

  // ステップ完了をログ
  stepComplete(step: string, durationMs: number): void {
    this.info(`[${step}] Completed in ${durationMs}ms`, {
      step,
      event: "step_complete",
      durationMs,
    });
  }

  // ステップ失敗をログ
  stepFailed(step: string, error: string): void {
    this.error(`[${step}] Failed: ${error}`, {
      step,
      event: "step_failed",
      error,
    });
  }

  // タスク開始をログ
  taskStart(taskTitle: string): void {
    this.info(`Starting task: ${taskTitle}`, { event: "task_start" });
  }

  // タスク完了をログ
  taskComplete(durationMs: number, prUrl?: string): void {
    this.info("Task completed successfully", {
      event: "task_complete",
      durationMs,
      prUrl,
    });
  }

  // タスク失敗をログ
  taskFailed(error: string, attempt?: number, maxAttempts?: number): void {
    this.error(`Task failed: ${error}`, {
      event: "task_failed",
      error,
      attempt,
      maxAttempts,
    });
  }

  // リトライをログ
  retry(attempt: number, maxAttempts: number, reason: string): void {
    this.warn(`Retrying (${attempt}/${maxAttempts}): ${reason}`, {
      event: "retry",
      attempt,
      maxAttempts,
      reason,
    });
  }
}

// デフォルトのWorkerロガーを作成
export function createWorkerLogger(agentId: string, taskId?: string, runId?: string): Logger {
  return new Logger({
    component: "worker",
    agentId,
    taskId,
    runId,
    minLevel: (process.env.LOG_LEVEL as LogLevel) ?? "info",
    jsonOutput: process.env.LOG_FORMAT === "json",
  });
}
