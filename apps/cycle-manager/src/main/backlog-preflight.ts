import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { CycleManagerConfig } from "./config";

type PreflightResponsePayload = {
  preflight?: {
    github?: {
      issueTaskBacklogCount?: number;
      generatedTaskCount?: number;
      openIssueCount?: number;
      openPrCount?: number;
      warnings?: string[];
    };
  };
  error?: string;
};

export type IssueBacklogSyncResult = {
  success: boolean;
  hasIssueBacklog: boolean;
  issueTaskBacklogCount: number;
  generatedTaskCount: number;
  openIssueCount: number;
  openPrCount: number;
  warnings: string[];
  reason?: string;
};

let issuePreflightInProgress = false;
let lastIssuePreflightAt: number | null = null;
let lastIssuePreflightResult: IssueBacklogSyncResult | null = null;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function getPreflightHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  const rawApiKeys = process.env.API_KEYS;
  if (rawApiKeys) {
    const firstApiKey = rawApiKeys
      .split(",")
      .map((value) => value.trim())
      .find((value) => value.length > 0);
    if (firstApiKey) {
      headers["x-api-key"] = firstApiKey;
      return headers;
    }
  }

  const apiSecret = process.env.API_SECRET?.trim();
  if (apiSecret) {
    headers.authorization = `Bearer ${apiSecret}`;
  }

  return headers;
}

function postJson(
  urlText: string,
  payload: string,
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(urlText);
    } catch (error) {
      reject(error);
      return;
    }

    const isHttps = url.protocol === "https:";
    const requestFn = isHttps ? httpsRequest : httpRequest;
    const req = requestFn(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          ...getPreflightHeaders(),
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    req.on("error", (error) => {
      reject(error);
    });
    req.write(payload);
    req.end();
  });
}

function buildDefaultResult(reason: string): IssueBacklogSyncResult {
  return {
    success: false,
    hasIssueBacklog: true,
    issueTaskBacklogCount: 0,
    generatedTaskCount: 0,
    openIssueCount: 0,
    openPrCount: 0,
    warnings: [],
    reason,
  };
}

export async function syncIssueBacklogViaPreflight(
  config: CycleManagerConfig,
): Promise<IssueBacklogSyncResult> {
  const now = Date.now();
  if (issuePreflightInProgress) {
    return (
      lastIssuePreflightResult ?? {
        ...buildDefaultResult("preflight_in_progress"),
        reason: "preflight_in_progress",
      }
    );
  }

  if (
    lastIssuePreflightAt &&
    lastIssuePreflightResult &&
    now - lastIssuePreflightAt < config.issueSyncIntervalMs
  ) {
    return lastIssuePreflightResult;
  }

  issuePreflightInProgress = true;
  lastIssuePreflightAt = now;

  try {
    const endpoint = new URL("/system/preflight", config.systemApiBaseUrl).toString();
    const body = JSON.stringify({
      autoCreateIssueTasks: true,
      autoCreatePrJudgeTasks: true,
    });
    const timeoutMs = parsePositiveInt(
      process.env.ISSUE_SYNC_TIMEOUT_MS,
      config.issueSyncTimeoutMs,
    );
    const response = await postJson(endpoint, body, timeoutMs);
    if (response.status < 200 || response.status >= 300) {
      const failed = buildDefaultResult(`http_${response.status}`);
      failed.warnings.push(response.body.slice(0, 300));
      lastIssuePreflightResult = failed;
      return failed;
    }

    let parsed: PreflightResponsePayload;
    try {
      parsed = JSON.parse(response.body) as PreflightResponsePayload;
    } catch {
      const failed = buildDefaultResult("invalid_json");
      failed.warnings.push(response.body.slice(0, 300));
      lastIssuePreflightResult = failed;
      return failed;
    }

    if (parsed.error) {
      const failed = buildDefaultResult("api_error");
      failed.warnings.push(parsed.error);
      lastIssuePreflightResult = failed;
      return failed;
    }

    const github = parsed.preflight?.github;
    const issueTaskBacklogCount = Math.max(0, Number(github?.issueTaskBacklogCount ?? 0));
    const generatedTaskCount = Math.max(0, Number(github?.generatedTaskCount ?? 0));
    const openIssueCount = Math.max(0, Number(github?.openIssueCount ?? 0));
    const openPrCount = Math.max(0, Number(github?.openPrCount ?? 0));
    const warnings = Array.isArray(github?.warnings)
      ? github.warnings.filter((value): value is string => typeof value === "string")
      : [];

    const result: IssueBacklogSyncResult = {
      success: true,
      hasIssueBacklog: issueTaskBacklogCount > 0,
      issueTaskBacklogCount,
      generatedTaskCount,
      openIssueCount,
      openPrCount,
      warnings,
    };
    lastIssuePreflightResult = result;
    return result;
  } catch (error) {
    const failed = buildDefaultResult("request_failed");
    if (error instanceof Error) {
      failed.warnings.push(error.message);
    }
    lastIssuePreflightResult = failed;
    return failed;
  } finally {
    issuePreflightInProgress = false;
  }
}
