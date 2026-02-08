import { describe, it, expect } from "vitest";
import {
  verifyGitHubWebhookSignature,
  isOpenTigerRelatedEvent,
  type PullRequestPayload,
  type IssuePayload,
  type WebhookPayload,
} from "../src/webhook";

describe("verifyGitHubWebhookSignature", () => {
  const secret = "test-webhook-secret";

  it("有効な署名を検証できる", () => {
    // sha256=で始まる署名を検証
    const payload = '{"action":"opened"}';

    // 正しい署名を生成するためのテスト
    const crypto = require("node:crypto");
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(payload);
    const correctSignature = "sha256=" + hmac.digest("hex");

    expect(verifyGitHubWebhookSignature(payload, correctSignature, secret)).toBe(true);
  });

  it("無効な署名を拒否する", () => {
    const payload = '{"action":"opened"}';
    const invalidSignature = "sha256=invalid_signature_that_does_not_match";

    expect(verifyGitHubWebhookSignature(payload, invalidSignature, secret)).toBe(false);
  });

  it("署名がundefinedの場合はfalseを返す", () => {
    const payload = '{"action":"opened"}';

    expect(verifyGitHubWebhookSignature(payload, undefined, secret)).toBe(false);
  });

  it("sha256=プレフィックスがない場合はfalseを返す", () => {
    const payload = '{"action":"opened"}';
    const signature = "md5=somehash";

    expect(verifyGitHubWebhookSignature(payload, signature, secret)).toBe(false);
  });

  it("署名部分が空の場合はfalseを返す", () => {
    const payload = '{"action":"opened"}';
    const signature = "sha256=";

    expect(verifyGitHubWebhookSignature(payload, signature, secret)).toBe(false);
  });

  it("Bufferペイロードを処理できる", () => {
    const payload = Buffer.from('{"action":"opened"}');
    const crypto = require("node:crypto");
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(payload.toString("utf8"));
    const correctSignature = "sha256=" + hmac.digest("hex");

    expect(verifyGitHubWebhookSignature(payload, correctSignature, secret)).toBe(true);
  });

  it("改ざんされたペイロードを検出する", () => {
    const originalPayload = '{"action":"opened"}';
    const crypto = require("node:crypto");
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(originalPayload);
    const signature = "sha256=" + hmac.digest("hex");

    // ペイロードを改ざん
    const tamperedPayload = '{"action":"closed"}';
    expect(verifyGitHubWebhookSignature(tamperedPayload, signature, secret)).toBe(false);
  });
});

describe("isOpenTigerRelatedEvent", () => {
  describe("Pull Request events", () => {
    it("agent/で始まるブランチのPRを検出する", () => {
      const payload: PullRequestPayload = {
        action: "opened",
        number: 42,
        pull_request: {
          number: 42,
          title: "Add auth feature",
          body: "Automated PR",
          state: "open",
          merged: false,
          head: {
            ref: "agent/worker-1/task-123",
            sha: "abc123",
          },
          base: {
            ref: "main",
            sha: "def456",
          },
          user: {
            login: "openTiger-bot",
          },
        },
      };

      expect(isOpenTigerRelatedEvent(payload)).toBe(true);
    });

    it("通常のブランチのPRは検出しない", () => {
      const payload: PullRequestPayload = {
        action: "opened",
        number: 43,
        pull_request: {
          number: 43,
          title: "Manual fix",
          body: null,
          state: "open",
          merged: false,
          head: {
            ref: "feature/login",
            sha: "abc123",
          },
          base: {
            ref: "main",
            sha: "def456",
          },
          user: {
            login: "developer",
          },
        },
      };

      expect(isOpenTigerRelatedEvent(payload)).toBe(false);
    });
  });

  describe("Issue events", () => {
    it("openTigerラベル付きのIssueを検出する", () => {
      const payload: IssuePayload = {
        action: "opened",
        issue: {
          number: 100,
          title: "Implement new feature",
          body: "Feature description",
          state: "open",
          labels: [{ name: "openTiger" }, { name: "enhancement" }],
          user: {
            login: "developer",
          },
        },
      };

      expect(isOpenTigerRelatedEvent(payload)).toBe(true);
    });

    it("auto-taskラベル付きのIssueを検出する", () => {
      const payload: IssuePayload = {
        action: "labeled",
        issue: {
          number: 101,
          title: "Bug fix needed",
          body: null,
          state: "open",
          labels: [{ name: "auto-task" }, { name: "bug" }],
          user: {
            login: "developer",
          },
        },
      };

      expect(isOpenTigerRelatedEvent(payload)).toBe(true);
    });

    it("関連ラベルなしのIssueは検出しない", () => {
      const payload: IssuePayload = {
        action: "opened",
        issue: {
          number: 102,
          title: "Regular issue",
          body: "Description",
          state: "open",
          labels: [{ name: "bug" }, { name: "priority-high" }],
          user: {
            login: "developer",
          },
        },
      };

      expect(isOpenTigerRelatedEvent(payload)).toBe(false);
    });

    it("ラベルなしのIssueは検出しない", () => {
      const payload: IssuePayload = {
        action: "opened",
        issue: {
          number: 103,
          title: "No labels",
          body: null,
          state: "open",
          labels: [],
          user: {
            login: "developer",
          },
        },
      };

      expect(isOpenTigerRelatedEvent(payload)).toBe(false);
    });
  });

  describe("Other events", () => {
    it("PRでもIssueでもないイベントはfalseを返す", () => {
      const payload: WebhookPayload = {
        action: "created",
        sender: {
          login: "developer",
          id: 12345,
        },
      };

      expect(isOpenTigerRelatedEvent(payload)).toBe(false);
    });
  });
});
