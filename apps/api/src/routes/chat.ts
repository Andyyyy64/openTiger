import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { db } from "@openTiger/db";
import { conversations, messages } from "@openTiger/db/schema";
import { eq, desc } from "drizzle-orm";
import { startChatExecution } from "@openTiger/llm";
import { ensureConfigRow } from "../config-store";
const SAFE_GIT_NAME_RE = /^[a-zA-Z0-9._-]+$/;
const SAFE_GIT_REF_RE = /^[a-zA-Z0-9._\/-]+$/;

import {
  createSession,
  getSession,
  pushChunk,
  markDone,
  markError,
  addListener,
  removeSession,
} from "./chat-state";
import {
  resolvePhase,
  buildSystemPrompt,
  resolveExecutorFromConfig,
  resolveModelFromConfig,
  PLAN_READY_MARKER,
} from "./chat-orchestrator";

export const chatRoute = new Hono();

// POST /conversations — create new conversation
chatRoute.post("/conversations", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const title = typeof body.title === "string" ? body.title : null;

    const [conversation] = await db
      .insert(conversations)
      .values({
        title,
        status: "active",
        metadata: { phase: "greeting" },
      })
      .returning();

    if (!conversation) {
      return c.json({ error: "Failed to create conversation" }, 500);
    }

    // Insert greeting message from assistant
    const [greetingMessage] = await db
      .insert(messages)
      .values({
        conversationId: conversation.id,
        role: "assistant",
        content:
          "Welcome to openTiger. What would you like to work on today?\n\nI can help with code tasks, research, bug fixes, and feature development.",
        messageType: "text",
      })
      .returning();

    return c.json({
      conversation,
      messages: greetingMessage ? [greetingMessage] : [],
    });
  } catch (error) {
    console.warn("[Chat] Failed to create conversation:", error);
    return c.json({ error: "Failed to create conversation" }, 500);
  }
});

// GET /conversations — list conversations
chatRoute.get("/conversations", async (c) => {
  try {
    const result = await db
      .select()
      .from(conversations)
      .orderBy(desc(conversations.updatedAt))
      .limit(50);

    return c.json({ conversations: result });
  } catch (error) {
    console.warn("[Chat] Failed to list conversations:", error);
    return c.json({ error: "Failed to list conversations" }, 500);
  }
});

// GET /conversations/:id — get conversation with messages
chatRoute.get("/conversations/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id));

    if (!conversation) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    const conversationMessages = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(messages.createdAt);

    return c.json({ conversation, messages: conversationMessages });
  } catch (error) {
    console.warn("[Chat] Failed to get conversation:", error);
    return c.json({ error: "Failed to get conversation" }, 500);
  }
});

// DELETE /conversations/:id — delete conversation
chatRoute.delete("/conversations/:id", async (c) => {
  try {
    const id = c.req.param("id");

    // Abort active LLM session if any
    removeSession(id);

    // Delete messages first (foreign key)
    await db.delete(messages).where(eq(messages.conversationId, id));
    const result = await db
      .delete(conversations)
      .where(eq(conversations.id, id))
      .returning();

    if (result.length === 0) {
      return c.json({ error: "Conversation not found" }, 404);
    }
    return c.json({ deleted: true });
  } catch (error) {
    console.warn("[Chat] Failed to delete conversation:", error);
    return c.json({ error: "Failed to delete conversation" }, 500);
  }
});

// POST /conversations/:id/messages — send user message + start LLM response
chatRoute.post("/conversations/:id/messages", async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json();
    const content = typeof body.content === "string" ? body.content : "";

    if (!content.trim()) {
      return c.json({ error: "Message content is required" }, 400);
    }

    // Verify conversation exists
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id));

    if (!conversation) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    // Save user message
    const [userMessage] = await db
      .insert(messages)
      .values({
        conversationId: id,
        role: "user",
        content: content.trim(),
        messageType: "text",
      })
      .returning();

    // Load all messages for context
    const allMessages = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(messages.createdAt);

    // Resolve phase and system prompt
    const metadata = (conversation.metadata ?? {}) as Record<string, unknown>;
    const phase = resolvePhase(allMessages, metadata);
    const systemPrompt = buildSystemPrompt(phase);

    // Load config for executor selection
    let configRow = null;
    try {
      configRow = await ensureConfigRow();
    } catch {
      // Config not available, use defaults
    }

    // Start LLM execution
    const executor = resolveExecutorFromConfig(configRow);
    const model = resolveModelFromConfig(configRow, executor);

    const chatMessages = allMessages
      .filter((m) => m.messageType === "text")
      .map((m) => ({
        role: m.role,
        content: m.content,
      }));

    const session = createSession(id);

    const handle = startChatExecution({
      executor,
      model,
      messages: chatMessages,
      systemPrompt,
      timeoutSeconds: 120,
    });

    session.abortFn = handle.abort;

    handle.onChunk((chunk) => {
      pushChunk(id, chunk);
    });

    handle.onDone(async (result) => {
      let responseContent = result.content || (result.success ? "(Empty response)" : "(LLM execution failed — check server logs for details)");

      // Check if LLM produced PLAN_READY marker
      const markerIndex = responseContent.indexOf(PLAN_READY_MARKER);
      const hasPlanMarker = markerIndex >= 0;

      // Strip the marker AND everything after it from saved content
      if (hasPlanMarker) {
        responseContent = responseContent.slice(0, markerIndex).trimEnd();
      }

      // Save assistant response to DB
      try {
        await db.insert(messages).values({
          conversationId: id,
          role: "assistant",
          content: responseContent,
          messageType: "text",
        });

        // If plan is ready, insert mode_selection system message
        if (hasPlanMarker) {
          await db.insert(messages).values({
            conversationId: id,
            role: "system",
            content: "Plan complete. Select execution mode to begin.",
            messageType: "mode_selection",
          });
        }

        // Resolve new phase: if marker present we know it's plan_proposal
        const newPhase = hasPlanMarker
          ? "plan_proposal" as const
          : resolvePhase(
              [...allMessages, { role: "assistant" as const, content: responseContent, messageType: "text" }],
              metadata,
            );
        await db
          .update(conversations)
          .set({
            metadata: { ...metadata, phase: newPhase },
            updatedAt: new Date(),
            title: conversation.title || content.trim().slice(0, 100),
          })
          .where(eq(conversations.id, id));
      } catch (dbError) {
        console.warn("[Chat] Failed to save assistant message:", dbError);
      }

      if (result.success) {
        markDone(id, responseContent);
      } else {
        markError(id, responseContent || "LLM execution failed");
      }
    });

    return c.json({
      userMessage,
      streaming: true,
    });
  } catch (error) {
    console.warn("[Chat] Failed to send message:", error);
    return c.json({ error: "Failed to send message" }, 500);
  }
});

// GET /conversations/:id/stream — SSE stream for LLM response chunks
chatRoute.get("/conversations/:id/stream", async (c) => {
  const id = c.req.param("id");
  const session = getSession(id);

  return streamSSE(c, async (stream) => {
    // First, replay any buffered chunks
    if (session) {
      for (const chunk of session.chunks) {
        await stream.writeSSE({ event: "chunk", data: chunk });
      }

      if (session.done) {
        if (session.error) {
          await stream.writeSSE({
            event: "error",
            data: session.error,
          });
        } else {
          await stream.writeSSE({
            event: "done",
            data: session.finalContent,
          });
        }
        return;
      }
    }

    // Then listen for new events
    await new Promise<void>((resolve) => {
      const cleanup = addListener(id, async (event) => {
        try {
          await stream.writeSSE({
            event: event.type,
            data: event.data,
          });
          if (event.type === "done" || event.type === "error") {
            cleanup();
            resolve();
          }
        } catch {
          cleanup();
          resolve();
        }
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        cleanup();
        resolve();
      }, 300_000);
    });
  });
});

// POST /conversations/:id/start-execution — unified mode selection + execution start
chatRoute.post("/conversations/:id/start-execution", async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json();
    const mode = body.mode === "git" || body.mode === "github"
      ? "github"
      : body.mode === "direct"
        ? "direct"
        : "local-git";
    const githubOwner = typeof body.githubOwner === "string" ? body.githubOwner.trim() : "";
    const githubRepo = typeof body.githubRepo === "string" ? body.githubRepo.trim() : "";
    const baseBranch = typeof body.baseBranch === "string" ? body.baseBranch.trim() || "main" : "main";

    if (mode === "github") {
      if (!SAFE_GIT_NAME_RE.test(githubOwner) || !SAFE_GIT_NAME_RE.test(githubRepo)) {
        return c.json({ error: "Invalid owner or repo name" }, 400);
      }
      if (baseBranch && (!SAFE_GIT_REF_RE.test(baseBranch) || baseBranch.includes(".."))) {
        return c.json({ error: "Invalid branch name" }, 400);
      }
    }

    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id));

    if (!conversation) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    const metadata = (conversation.metadata ?? {}) as Record<string, unknown>;

    // Update global config to match selected mode
    try {
      const configRow = await ensureConfigRow();
      const { config: configTable } = await import("@openTiger/db/schema");
      if (mode === "github" && githubOwner && githubRepo) {
        const repoUrl = `https://github.com/${githubOwner}/${githubRepo}`;
        await db
          .update(configTable)
          .set({
            repoMode: "github",
            repoUrl,
            githubOwner,
            githubRepo,
            baseBranch,
            updatedAt: new Date(),
          })
          .where(eq(configTable.id, configRow.id));
      } else if (mode === "direct") {
        await db
          .update(configTable)
          .set({
            repoMode: "direct",
            workerCount: "1",
            updatedAt: new Date(),
          })
          .where(eq(configTable.id, configRow.id));
      } else {
        await db
          .update(configTable)
          .set({
            repoMode: "local-git",
            updatedAt: new Date(),
          })
          .where(eq(configTable.id, configRow.id));
      }
    } catch {
      // Config update is best-effort
    }

    // Update conversation to execution phase
    await db
      .update(conversations)
      .set({
        metadata: {
          ...metadata,
          phase: "execution",
          repoMode: mode,
          ...(mode === "github" ? { githubOwner, githubRepo, baseBranch } : {}),
        },
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, id));

    // Insert execution_status system message
    const modeLabel = mode === "github"
      ? `github (${githubOwner}/${githubRepo}:${baseBranch})`
      : mode === "direct"
        ? "direct (no git)"
        : "local-git";
    const [statusMessage] = await db
      .insert(messages)
      .values({
        conversationId: id,
        role: "system",
        content: `Execution started in ${modeLabel} mode.`,
        messageType: "execution_status",
        metadata: { repoMode: mode, githubOwner, githubRepo, baseBranch },
      })
      .returning();

    return c.json({
      started: true,
      mode,
      message: statusMessage,
    });
  } catch (error) {
    console.warn("[Chat] Failed to start execution:", error);
    return c.json({ error: "Failed to start execution" }, 500);
  }
});

// POST /conversations/:id/confirm-plan — legacy: confirm plan and start execution
chatRoute.post("/conversations/:id/confirm-plan", async (c) => {
  try {
    const id = c.req.param("id");
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id));

    if (!conversation) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    const metadata = (conversation.metadata ?? {}) as Record<string, unknown>;

    // Determine repo mode — default to local if not configured
    let repoMode = metadata.repoMode as string | undefined;
    if (!repoMode) {
      repoMode = "local-git";
    }

    // Update conversation to execution phase
    await db
      .update(conversations)
      .set({
        metadata: { ...metadata, phase: "execution", repoMode },
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, id));

    // Insert system message about execution start
    const [statusMessage] = await db
      .insert(messages)
      .values({
        conversationId: id,
        role: "system",
        content: `Plan confirmed. Starting execution in ${repoMode} mode...`,
        messageType: "execution_status",
        metadata: { repoMode },
      })
      .returning();

    return c.json({
      confirmed: true,
      repoMode,
      message: statusMessage,
    });
  } catch (error) {
    console.warn("[Chat] Failed to confirm plan:", error);
    return c.json({ error: "Failed to confirm plan" }, 500);
  }
});

// POST /conversations/:id/configure-repo — legacy: configure Git/repo settings
chatRoute.post("/conversations/:id/configure-repo", async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json();

    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id));

    if (!conversation) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    const metadata = (conversation.metadata ?? {}) as Record<string, unknown>;

    // Update conversation metadata with repo config
    const rawRepoMode = body.repoMode;
    const repoConfig = {
      repoMode: rawRepoMode === "github" || rawRepoMode === "git"
        ? "github"
        : rawRepoMode === "direct"
          ? "direct"
          : rawRepoMode === "local-git" || rawRepoMode === "local"
            ? "local-git"
            : "github",
      githubOwner: typeof body.githubOwner === "string" ? body.githubOwner.trim() : "",
      githubRepo: typeof body.githubRepo === "string" ? body.githubRepo.trim() : "",
      baseBranch: typeof body.baseBranch === "string" ? body.baseBranch.trim() || "main" : "main",
    };
    if (repoConfig.repoMode === "github" && repoConfig.githubOwner && repoConfig.githubRepo) {
      if (!SAFE_GIT_NAME_RE.test(repoConfig.githubOwner) || !SAFE_GIT_NAME_RE.test(repoConfig.githubRepo)) {
        return c.json({ error: "Invalid owner or repo name" }, 400);
      }
      if (repoConfig.baseBranch && (!SAFE_GIT_REF_RE.test(repoConfig.baseBranch) || repoConfig.baseBranch.includes(".."))) {
        return c.json({ error: "Invalid branch name" }, 400);
      }
    }

    await db
      .update(conversations)
      .set({
        metadata: { ...metadata, ...repoConfig },
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, id));

    // Also update global config if provided
    try {
      const configRow = await ensureConfigRow();
      if (repoConfig.githubOwner && repoConfig.githubRepo) {
        const { config: configTable } = await import("@openTiger/db/schema");
        await db
          .update(configTable)
          .set({
            repoMode: repoConfig.repoMode,
            githubOwner: repoConfig.githubOwner,
            githubRepo: repoConfig.githubRepo,
            baseBranch: repoConfig.baseBranch,
            updatedAt: new Date(),
          })
          .where(eq(configTable.id, configRow.id));
      }
    } catch {
      // Config update is best-effort
    }

    // Insert system confirmation message
    await db.insert(messages).values({
      conversationId: id,
      role: "system",
      content: `Repository configured: ${repoConfig.githubOwner}/${repoConfig.githubRepo} (${repoConfig.baseBranch})`,
      messageType: "repo_config",
    });

    return c.json({ configured: true, repoConfig });
  } catch (error) {
    console.warn("[Chat] Failed to configure repo:", error);
    return c.json({ error: "Failed to configure repo" }, 500);
  }
});
