import { createHmac, timingSafeEqual } from "node:crypto";

// Webhook署名の検証
export function verifyGitHubWebhookSignature(
  payload: string | Buffer,
  signature: string | undefined,
  secret: string
): boolean {
  if (!signature) {
    return false;
  }

  // sha256=... の形式から署名部分を抽出
  const parts = signature.split("=");
  if (parts.length !== 2 || parts[0] !== "sha256") {
    return false;
  }

  const signatureHex = parts[1];
  if (!signatureHex) {
    return false;
  }

  // HMAC-SHA256で署名を計算
  const hmac = createHmac("sha256", secret);
  hmac.update(typeof payload === "string" ? payload : payload.toString("utf8"));
  const expectedSignature = hmac.digest("hex");

  // タイミング攻撃を防ぐため、一定時間比較を使用
  try {
    return timingSafeEqual(
      Buffer.from(signatureHex, "hex"),
      Buffer.from(expectedSignature, "hex")
    );
  } catch {
    return false;
  }
}

// Webhookイベントタイプ
export type GitHubEventType =
  | "ping"
  | "push"
  | "pull_request"
  | "issues"
  | "issue_comment"
  | "check_run"
  | "check_suite"
  | "workflow_run"
  | "create"
  | "delete"
  | "release";

// Webhookペイロードの基本構造
export interface WebhookPayload {
  action?: string;
  sender?: {
    login: string;
    id: number;
  };
  repository?: {
    full_name: string;
    name: string;
    owner: {
      login: string;
    };
  };
}

// Pull Requestイベントのペイロード
export interface PullRequestPayload extends WebhookPayload {
  action:
    | "opened"
    | "closed"
    | "reopened"
    | "synchronize"
    | "edited"
    | "ready_for_review"
    | "converted_to_draft";
  number: number;
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    state: "open" | "closed";
    merged: boolean;
    head: {
      ref: string;
      sha: string;
    };
    base: {
      ref: string;
      sha: string;
    };
    user: {
      login: string;
    };
  };
}

// Issueイベントのペイロード
export interface IssuePayload extends WebhookPayload {
  action: "opened" | "closed" | "reopened" | "edited" | "labeled" | "unlabeled";
  issue: {
    number: number;
    title: string;
    body: string | null;
    state: "open" | "closed";
    labels: Array<{ name: string }>;
    user: {
      login: string;
    };
  };
}

// Pushイベントのペイロード
export interface PushPayload extends WebhookPayload {
  ref: string;
  before: string;
  after: string;
  commits: Array<{
    id: string;
    message: string;
    author: {
      name: string;
      email: string;
    };
    added: string[];
    removed: string[];
    modified: string[];
  }>;
  head_commit: {
    id: string;
    message: string;
  } | null;
}

// Check Run/Suiteイベントのペイロード
export interface CheckPayload extends WebhookPayload {
  action: "created" | "completed" | "rerequested";
  check_run?: {
    id: number;
    name: string;
    status: "queued" | "in_progress" | "completed";
    conclusion: "success" | "failure" | "neutral" | "cancelled" | "timed_out" | "action_required" | null;
    pull_requests: Array<{ number: number }>;
  };
  check_suite?: {
    id: number;
    status: "queued" | "in_progress" | "completed";
    conclusion: "success" | "failure" | "neutral" | "cancelled" | "timed_out" | "action_required" | null;
    pull_requests: Array<{ number: number }>;
  };
}

// イベントがopenTiger関連かどうかを判定
export function isOpenTigerRelatedEvent(payload: WebhookPayload): boolean {
  // openTiger が作成したPRかチェック（ブランチ名で判定）
  if ("pull_request" in payload) {
    const pr = (payload as PullRequestPayload).pull_request;
    if (pr.head.ref.startsWith("agent/")) {
      return true;
    }
  }

  // openTiger ラベルが付いているIssueかチェック
  if ("issue" in payload) {
    const issue = (payload as IssuePayload).issue;
    if (issue.labels.some((l) => l.name === "openTiger" || l.name === "auto-task")) {
      return true;
    }
  }

  return false;
}
