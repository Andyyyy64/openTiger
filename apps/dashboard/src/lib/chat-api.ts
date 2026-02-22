import { fetchApi } from "./api";

export interface Conversation {
  id: string;
  title: string | null;
  status: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  messageType: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface RepoConfig {
  repoMode: string;
  githubOwner: string;
  githubRepo: string;
  baseBranch: string;
}

export const chatApi = {
  createConversation: (title?: string) =>
    fetchApi<{ conversation: Conversation; messages: ChatMessage[] }>("/chat/conversations", {
      method: "POST",
      body: JSON.stringify({ title }),
    }),

  listConversations: () =>
    fetchApi<{ conversations: Conversation[] }>("/chat/conversations").then(
      (res) => res.conversations,
    ),

  getConversation: (id: string) =>
    fetchApi<{ conversation: Conversation; messages: ChatMessage[] }>(
      `/chat/conversations/${id}`,
    ),

  deleteConversation: (id: string) =>
    fetchApi<{ deleted: boolean }>(`/chat/conversations/${id}`, {
      method: "DELETE",
    }),

  sendMessage: (id: string, content: string) =>
    fetchApi<{ userMessage: ChatMessage; streaming: boolean }>(
      `/chat/conversations/${id}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),

  confirmPlan: (id: string) =>
    fetchApi<{ confirmed: boolean; repoMode: string; message: ChatMessage }>(
      `/chat/conversations/${id}/confirm-plan`,
      { method: "POST" },
    ),

  configureRepo: (id: string, config: RepoConfig) =>
    fetchApi<{ configured: boolean; repoConfig: RepoConfig }>(
      `/chat/conversations/${id}/configure-repo`,
      {
        method: "POST",
        body: JSON.stringify(config),
      },
    ),

  startExecution: (
    id: string,
    config: {
      mode: "local" | "git";
      githubOwner?: string;
      githubRepo?: string;
      baseBranch?: string;
    },
  ) =>
    fetchApi<{ started: boolean; mode: string; message: ChatMessage }>(
      `/chat/conversations/${id}/start-execution`,
      {
        method: "POST",
        body: JSON.stringify(config),
      },
    ),
};

const API_BASE_URL = "/api";

/**
 * Subscribe to chat SSE stream using fetch (not EventSource) to avoid
 * automatic reconnection which would replay buffered chunks and duplicate text.
 */
export function subscribeToChatStream(
  conversationId: string,
  onChunk: (text: string) => void,
  onDone: (content: string) => void,
  onError: (error: string) => void,
): () => void {
  const controller = new AbortController();

  (async () => {
    try {
      const response = await fetch(
        `${API_BASE_URL}/chat/conversations/${conversationId}/stream`,
        { signal: controller.signal, headers: { Accept: "text/event-stream" } },
      );

      if (!response.ok || !response.body) {
        onError(`Stream connection failed: ${response.status}`);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        // Keep the last incomplete line in the buffer
        buffer = lines.pop() ?? "";

        let currentEvent = "";
        let dataLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
            dataLines = [];
          } else if (line.startsWith("data: ")) {
            dataLines.push(line.slice(6));
          } else if (line === "") {
            // Empty line = end of SSE event block — dispatch accumulated data
            if (currentEvent && dataLines.length > 0) {
              const data = dataLines.join("\n");
              if (currentEvent === "chunk") {
                onChunk(data);
              } else if (currentEvent === "done") {
                onDone(data);
                return;
              } else if (currentEvent === "error") {
                onError(data);
                return;
              }
            }
            currentEvent = "";
            dataLines = [];
          }
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      onError(err instanceof Error ? err.message : "Stream error");
    }
  })();

  return () => {
    controller.abort();
  };
}
