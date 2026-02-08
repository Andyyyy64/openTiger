import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { healthRoute } from "../src/routes/health";

describe("healthRoute", () => {
  it("returns basic health status", async () => {
    const app = new Hono();
    app.route("/health", healthRoute);

    const response = await app.request("/health");
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      status: string;
      timestamp: string;
    };
    expect(payload.status).toBe("ok");
    expect(typeof payload.timestamp).toBe("string");
    expect(payload.timestamp.length).toBeGreaterThan(0);
  });
});
