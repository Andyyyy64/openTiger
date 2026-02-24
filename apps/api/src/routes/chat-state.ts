/**
 * In-memory state management for active chat streaming sessions.
 * Each conversation can have at most one active executor at a time.
 */

export interface ChatSSEEvent {
  type: "chunk" | "done" | "error" | "status";
  data: string;
}

export interface ActiveChatSession {
  chunks: string[];
  listeners: Set<(event: ChatSSEEvent) => void>;
  done: boolean;
  finalContent: string;
  error: string | null;
  abortFn: (() => void) | null;
}

const activeSessions = new Map<string, ActiveChatSession>();

export function getSession(conversationId: string): ActiveChatSession | undefined {
  return activeSessions.get(conversationId);
}

export function createSession(conversationId: string): ActiveChatSession {
  // Abort any existing session for this conversation
  const existing = activeSessions.get(conversationId);
  if (existing?.abortFn) {
    existing.abortFn();
  }

  const session: ActiveChatSession = {
    chunks: [],
    listeners: new Set(),
    done: false,
    finalContent: "",
    error: null,
    abortFn: null,
  };
  activeSessions.set(conversationId, session);
  return session;
}

export function pushChunk(conversationId: string, text: string): void {
  const session = activeSessions.get(conversationId);
  if (!session) return;
  session.chunks.push(text);
  const event: ChatSSEEvent = { type: "chunk", data: text };
  for (const listener of session.listeners) {
    listener(event);
  }
}

/** Auto-remove session after a delay to allow late-connecting SSE clients to catch up. */
const SESSION_CLEANUP_DELAY_MS = 60_000;

function scheduleCleanup(conversationId: string, session: ActiveChatSession): void {
  setTimeout(() => {
    // Only delete if the map still holds the same session instance
    if (activeSessions.get(conversationId) === session) {
      activeSessions.delete(conversationId);
    }
  }, SESSION_CLEANUP_DELAY_MS);
}

export function markDone(conversationId: string, finalContent: string): void {
  const session = activeSessions.get(conversationId);
  if (!session) return;
  session.done = true;
  session.finalContent = finalContent;
  const event: ChatSSEEvent = { type: "done", data: finalContent };
  for (const listener of session.listeners) {
    listener(event);
  }
  scheduleCleanup(conversationId, session);
}

export function markError(conversationId: string, error: string): void {
  const session = activeSessions.get(conversationId);
  if (!session) return;
  session.done = true;
  session.error = error;
  const event: ChatSSEEvent = { type: "error", data: error };
  for (const listener of session.listeners) {
    listener(event);
  }
  scheduleCleanup(conversationId, session);
}

export function addListener(
  conversationId: string,
  listener: (event: ChatSSEEvent) => void,
): () => void {
  const session = activeSessions.get(conversationId);
  if (!session) return () => {};
  session.listeners.add(listener);
  return () => {
    session.listeners.delete(listener);
  };
}

export function removeSession(conversationId: string): void {
  const session = activeSessions.get(conversationId);
  if (session?.abortFn) {
    session.abortFn();
  }
  activeSessions.delete(conversationId);
}
