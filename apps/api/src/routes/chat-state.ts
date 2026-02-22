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

export function markDone(conversationId: string, finalContent: string): void {
  const session = activeSessions.get(conversationId);
  if (!session) return;
  session.done = true;
  session.finalContent = finalContent;
  const event: ChatSSEEvent = { type: "done", data: finalContent };
  for (const listener of session.listeners) {
    listener(event);
  }
}

export function markError(conversationId: string, error: string): void {
  const session = activeSessions.get(conversationId);
  if (!session) return;
  session.done = true;
  const event: ChatSSEEvent = { type: "error", data: error };
  for (const listener of session.listeners) {
    listener(event);
  }
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
