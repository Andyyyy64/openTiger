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

  it("can verify a valid signature", () => {
    // Verify a signature starting with sha256=
    const payload = '{"action":"opened"}';

    // Test to generate a correct signature
    const crypto = require("node:crypto");
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(payload);
    const correctSignature = "sha256=" + hmac.digest("hex");

    expect(verifyGitHubWebhookSignature(payload, correctSignature, secret)).toBe(true);
  });

  it("rejects an invalid signature", () => {
    const payload = '{"action":"opened"}';
    const invalidSignature = "sha256=invalid_signature_that_does_not_match";

    expect(verifyGitHubWebhookSignature(payload, invalidSignature, secret)).toBe(false);
  });

  it("returns false when signature is undefined", () => {
    const payload = '{"action":"opened"}';

    expect(verifyGitHubWebhookSignature(payload, undefined, secret)).toBe(false);
  });

  it("returns false when sha256= prefix is missing", () => {
    const payload = '{"action":"opened"}';
    const signature = "md5=somehash";

    expect(verifyGitHubWebhookSignature(payload, signature, secret)).toBe(false);
  });

  it("returns false when the signature part is empty", () => {
    const payload = '{"action":"opened"}';
    const signature = "sha256=";

    expect(verifyGitHubWebhookSignature(payload, signature, secret)).toBe(false);
  });

  it("can handle a Buffer payload", () => {
    const payload = Buffer.from('{"action":"opened"}');
    const crypto = require("node:crypto");
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(payload.toString("utf8"));
    const correctSignature = "sha256=" + hmac.digest("hex");

    expect(verifyGitHubWebhookSignature(payload, correctSignature, secret)).toBe(true);
  });

  it("detects a tampered payload", () => {
    const originalPayload = '{"action":"opened"}';
    const crypto = require("node:crypto");
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(originalPayload);
    const signature = "sha256=" + hmac.digest("hex");

    // Tamper with the payload
    const tamperedPayload = '{"action":"closed"}';
    expect(verifyGitHubWebhookSignature(tamperedPayload, signature, secret)).toBe(false);
  });
});

describe("isOpenTigerRelatedEvent", () => {
  describe("Pull Request events", () => {
    it("detects a PR from a branch starting with agent/", () => {
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

    it("does not detect a PR from a regular branch", () => {
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
    it("detects an issue with the openTiger label", () => {
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

    it("detects an issue with the auto-task label", () => {
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

    it("does not detect an issue without a related label", () => {
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

    it("does not detect an issue with no labels", () => {
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
    it("returns false for events that are neither PR nor Issue", () => {
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
