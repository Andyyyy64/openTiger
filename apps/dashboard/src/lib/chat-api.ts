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
};

const API_BASE_URL = "/api";

export function subscribeToChatStream(
  conversationId: string,
  onChunk: (text: string) => void,
  onDone: (content: string) => void,
  onError: (error: string) => void,
): () => void {
  const controller = new AbortController();

  const connect = () => {
    const eventSource = new EventSource(
      `${API_BASE_URL}/chat/conversations/${conversationId}/stream`,
    );

    eventSource.addEventListener("chunk", (event) => {
      onChunk(event.data);
    });

    eventSource.addEventListener("done", (event) => {
      onDone(event.data);
      eventSource.close();
    });

    eventSource.addEventListener("error", () => {
      // EventSource auto-reconnects on error, but we want to handle it
      if (eventSource.readyState === EventSource.CLOSED) {
        onError("Stream connection closed");
      }
    });

    controller.signal.addEventListener("abort", () => {
      eventSource.close();
    });
  };

  connect();

  return () => {
    controller.abort();
  };
}
