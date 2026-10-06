import { randomUUID } from "node:crypto";

import type { ChatDurableEvent, ChatTurn } from "@roster/superset";
import { vi } from "vitest";

type Handler = ((event: { data: unknown }) => void) | null;

export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  onopen: Handler = null;
  onmessage: Handler = null;
  onerror: Handler = null;
  onclose: Handler = null;
  opened = false;
  closed = false;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(): void {}

  close(): void {
    this.closed = true;
  }
}

vi.stubGlobal("WebSocket", FakeWebSocket);

export function fakeChatUrl(sessionId: string): string {
  return `chat://${sessionId}`;
}

const POLL_MS = 5;
const DEADLINE_MS = 3000;

export async function waitFor<T>(
  read: () => T | Promise<T>,
  done: (value: T) => boolean = Boolean,
): Promise<T> {
  const deadline = Date.now() + DEADLINE_MS;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    value = await read();
  }
  return value;
}

export async function chatSessionOf(rosterSessionId: string): Promise<string> {
  const { db, threadSessions } = await import("@roster/db");
  const { eq } = await import("drizzle-orm");

  const id = await waitFor(async () => {
    const [row] = await db
      .select({ chat: threadSessions.supersetChatSessionId })
      .from(threadSessions)
      .where(eq(threadSessions.id, rosterSessionId));
    return row?.chat ?? null;
  });
  if (!id) throw new Error(`session ${rosterSessionId} never opened a chat`);
  return id;
}

export async function chatSocket(chatSessionId: string): Promise<FakeWebSocket> {
  const url = fakeChatUrl(chatSessionId);
  const socket = await waitFor(() =>
    FakeWebSocket.instances
      .filter(
        (candidate) =>
          candidate.url === url && !candidate.closed && candidate.onmessage !== null,
      )
      .at(-1),
  );
  if (!socket) throw new Error(`no chat stream opened for ${chatSessionId}`);
  if (!socket.opened) {
    socket.opened = true;
    socket.onopen?.({ data: null });
  }
  return socket;
}

const seqs = new Map<string, number>();

export async function emitChat(
  chatSessionId: string,
  event: ChatDurableEvent,
): Promise<void> {
  const socket = await chatSocket(chatSessionId);
  const seq = (seqs.get(chatSessionId) ?? 0) + 1;
  seqs.set(chatSessionId, seq);
  socket.onmessage?.({
    data: JSON.stringify({
      v: 1,
      sessionId: chatSessionId,
      ts: Date.now(),
      cursor: { epoch: "epoch-1", seq },
      event,
    }),
  });
  const { chatEventsSettled } = await import("../services/sessions/supervisor");
  await chatEventsSettled();
}

export function emitTurn(
  chatSessionId: string,
  turn: Partial<ChatTurn> & Pick<ChatTurn, "id" | "status">,
): Promise<void> {
  const startedAtMs = turn.startedAtMs ?? Date.now() - 1000;
  return emitChat(chatSessionId, {
    type: "turn",
    turn: {
      startedAtMs,
      ...(turn.status === "running" ? {} : { completedAtMs: startedAtMs + 1000 }),
      ...turn,
    },
  });
}

export function emitAgentMessage(
  chatSessionId: string,
  turnId: string,
  text: string,
): Promise<void> {
  return emitChat(chatSessionId, {
    type: "item",
    turnId,
    item: { kind: "agent_message", id: randomUUID(), text, startedAtMs: Date.now() },
  });
}

export async function completeTurn(
  chatSessionId: string,
  reply?: string,
): Promise<string> {
  const id = `turn-${randomUUID()}`;
  const startedAtMs = Date.now() - 1000;
  await emitTurn(chatSessionId, { id, status: "running", startedAtMs });
  if (reply !== undefined) await emitAgentMessage(chatSessionId, id, reply);
  await emitTurn(chatSessionId, {
    id,
    status: "completed",
    startedAtMs,
    completedAtMs: Date.now(),
  });
  return id;
}
