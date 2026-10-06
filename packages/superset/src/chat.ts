import { randomUUID } from "node:crypto";

import {
  type ChatCursor,
  type ChatDecision,
  type ChatDeltaChannel,
  type ChatDurableEnvelope,
  type ChatSessionStatus,
  serializeChatCursor,
} from "./chat-protocol";
import { SupersetError } from "./client";

const RELAY_URL = process.env.SUPERSET_RELAY_URL ?? "https://relay.superset.sh";

export const DEFAULT_CHAT_HARNESS = process.env.ROSTER_CHAT_HARNESS ?? "claude-acp";

export class ChatCallError extends SupersetError {
  constructor(
    message: string,
    status: number | undefined,
    readonly code: string | null,
  ) {
    super(message, status);
    this.name = "ChatCallError";
  }
}

async function chatCall<T>(args: {
  jwt: string;
  routingKey: string;
  procedure: string;
  input: unknown;
  what: string;
  method: "GET" | "POST";
  timeoutMs?: number;
}): Promise<T> {
  const base = `${RELAY_URL}/hosts/${args.routingKey}/chat-v3/trpc/${args.procedure}`;
  const serialized = JSON.stringify(args.input ?? {});
  const url =
    args.method === "GET"
      ? `${base}?input=${encodeURIComponent(serialized)}`
      : base;

  let response: Response;
  try {
    response = await fetch(url, {
      method: args.method,
      headers: {
        Authorization: `Bearer ${args.jwt}`,
        "Content-Type": "application/json",
      },
      body: args.method === "POST" ? serialized : undefined,
      signal: AbortSignal.timeout(args.timeoutMs ?? 30_000),
    });
  } catch (cause) {
    throw new SupersetError(
      `${args.what} could not reach that machine. ${(cause as Error).message}`,
    );
  }

  const raw = await response.text();
  let parsed: {
    result?: { data?: unknown };
    error?: { message?: string; data?: { code?: string } };
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ChatCallError(
      `${args.what} failed with ${response.status}: ${raw.slice(0, 300)}`,
      response.status,
      null,
    );
  }

  if (!response.ok || parsed.error) {
    throw new ChatCallError(
      `${args.what} failed: ${parsed.error?.message ?? raw.slice(0, 300)}`,
      response.status,
      parsed.error?.data?.code ?? null,
    );
  }

  return parsed.result?.data as T;
}

export interface ChatHost {
  jwt: string;
  routingKey: string;
}

export async function createChatSession(
  host: ChatHost & {
    workspaceId: string;
    harness?: string;
    resumeHarnessSessionId?: string | null;
  },
): Promise<{ sessionId: string; epoch: string }> {
  return chatCall({
    ...host,
    procedure: "createSession",
    input: {
      commandId: randomUUID(),
      workspaceId: host.workspaceId,
      harness: host.harness ?? DEFAULT_CHAT_HARNESS,
      ...(host.resumeHarnessSessionId
        ? { resume: { harnessSessionId: host.resumeHarnessSessionId } }
        : {}),
    },
    what: "Starting the agent",
    method: "POST",
    timeoutMs: 60_000,
  });
}

export async function promptChat(
  host: ChatHost & { sessionId: string; text: string },
): Promise<{ itemId: string; queued: boolean }> {
  return chatCall({
    ...host,
    procedure: "prompt",
    input: {
      commandId: randomUUID(),
      sessionId: host.sessionId,
      clientId: randomUUID(),
      content: [{ type: "text", text: host.text }],
    },
    what: "Sending the agent a message",
    method: "POST",
  });
}

export async function cancelChatTurn(
  host: ChatHost & { sessionId: string; turnId: string },
): Promise<void> {
  await chatCall({
    ...host,
    procedure: "cancelTurn",
    input: {
      commandId: randomUUID(),
      sessionId: host.sessionId,
      turnId: host.turnId,
      pauseQueue: true,
    },
    what: "Stopping the agent",
    method: "POST",
  });
}

export async function closeChatSession(
  host: ChatHost & { sessionId: string },
): Promise<void> {
  await chatCall({
    ...host,
    procedure: "closeSession",
    input: { sessionId: host.sessionId },
    what: "Closing the agent session",
    method: "POST",
  });
}

export async function respondToChatApproval(
  host: ChatHost & {
    sessionId: string;
    approvalId: string;
    decision: ChatDecision;
  },
): Promise<void> {
  await chatCall({
    ...host,
    procedure: "respondToApproval",
    input: {
      commandId: randomUUID(),
      sessionId: host.sessionId,
      approvalId: host.approvalId,
      decision: host.decision,
    },
    what: "Answering the agent",
    method: "POST",
  });
}

export async function stopChatBackgroundTask(
  host: ChatHost & { sessionId: string; taskId: string },
): Promise<boolean> {
  return chatCall({
    ...host,
    procedure: "stopBackgroundTask",
    input: {
      commandId: randomUUID(),
      sessionId: host.sessionId,
      taskId: host.taskId,
    },
    what: "Stopping that background task",
    method: "POST",
  });
}

export interface ChatSessionRow {
  sessionId: string;
  scopeId: string;
  harness: string;
  harnessSessionId: string | null;
  epoch: string;
  status: ChatSessionStatus;
  title: string | null;
}

export async function getChatSession(
  host: ChatHost & { sessionId: string },
): Promise<{ session: ChatSessionRow | null; cursor: ChatCursor | null; live: boolean }> {
  return chatCall({
    ...host,
    procedure: "getSession",
    input: { sessionId: host.sessionId },
    what: "Checking the agent session",
    method: "GET",
  });
}

export type ChatItemsPage =
  | { ok: true; envelopes: ChatDurableEnvelope[]; nextBefore: ChatCursor | null }
  | { ok: false; reset: string };

export async function getChatItems(
  host: ChatHost & { sessionId: string; before?: ChatCursor | null; limit?: number },
): Promise<ChatItemsPage> {
  return chatCall({
    ...host,
    procedure: "getItems",
    input: {
      sessionId: host.sessionId,
      ...(host.before ? { before: host.before } : {}),
      limit: host.limit ?? 200,
    },
    what: "Reading the agent conversation",
    method: "GET",
  });
}

export const CHAT_STREAM_DELTAS: readonly ChatDeltaChannel[] = [
  "text",
  "tool_input",
  "terminal",
  "background",
];

export function chatStreamUrl(args: {
  routingKey: string;
  sessionId: string;
  jwt: string;
  since?: ChatCursor | null;
  deltas?: readonly ChatDeltaChannel[];
}): string {
  const query = new URLSearchParams();
  if (args.since) query.set("since", serializeChatCursor(args.since));
  const deltas = args.deltas ?? CHAT_STREAM_DELTAS;
  if (deltas.length > 0) query.set("deltas", deltas.join(","));
  query.set("token", args.jwt);
  const base = RELAY_URL.replace(/^http/, "ws");
  return `${base}/hosts/${args.routingKey}/chat-v3/sessions/${encodeURIComponent(
    args.sessionId,
  )}/stream?${query.toString()}`;
}
