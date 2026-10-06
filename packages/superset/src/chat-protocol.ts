export interface ChatCursor {
  epoch: string;
  seq: number;
}

export function serializeChatCursor(cursor: ChatCursor): string {
  return `${cursor.epoch}:${cursor.seq}`;
}

export function parseChatCursor(value: string | null | undefined): ChatCursor | null {
  if (!value) return null;
  const splitAt = value.lastIndexOf(":");
  if (splitAt <= 0) return null;
  const seq = Number(value.slice(splitAt + 1));
  if (!Number.isInteger(seq) || seq < 0) return null;
  return { epoch: value.slice(0, splitAt), seq };
}

export type ChatUserContent =
  | { type: "text"; text: string }
  | { type: "attachment"; attachmentId: string; name: string; mimeType: string };

export type ChatToolContent =
  | { type: "text"; text: string }
  | { type: "diff"; path: string; oldText: string | null; newText: string }
  | {
      type: "terminal";
      command: string;
      output: string;
      exitCode?: number;
      truncated?: boolean;
    };

export type ChatDecision =
  | { type: "accept" }
  | { type: "accept_for_session" }
  | { type: "decline" }
  | { type: "cancel" }
  | { type: "option"; optionId: string };

interface ChatItemBase {
  id: string;
  parentItemId?: string;
  startedAtMs: number;
  completedAtMs?: number;
}

export interface ChatUserMessage extends ChatItemBase {
  kind: "user_message";
  clientId?: string;
  queued?: boolean;
  discarded?: boolean;
  content: ChatUserContent[];
}

export interface ChatAgentMessage extends ChatItemBase {
  kind: "agent_message";
  text: string;
}

export interface ChatReasoning extends ChatItemBase {
  kind: "reasoning";
  text: string;
  summary?: string;
}

export type ChatToolStatus =
  | "running"
  | "completed"
  | "failed"
  | "declined"
  | "canceled";

export interface ChatToolCall extends ChatItemBase {
  kind: "tool_call";
  title: string;
  toolKind: string;
  toolName: string;
  status: ChatToolStatus;
  content: ChatToolContent[];
  locations?: { path: string; line?: number }[];
  subagent?: boolean;
}

export interface ChatPlan extends ChatItemBase {
  kind: "plan";
  entries: { text: string; status: "pending" | "in_progress" | "completed" }[];
}

export interface ChatApprovalRequest extends ChatItemBase {
  kind: "approval_request";
  targetItemId: string | null;
  title: string;
  detail?: ChatToolContent[];
  options?: {
    optionId: string;
    label: string;
    kind?: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  }[];
  status: "pending" | "answered" | "stale";
  decision?: ChatDecision;
}

export interface ChatNotice extends ChatItemBase {
  kind: "notice";
  noticeKind: "compaction" | "config_change" | "error" | "info";
  text?: string;
}

export type ChatItem =
  | ChatUserMessage
  | ChatAgentMessage
  | ChatReasoning
  | ChatToolCall
  | ChatPlan
  | ChatApprovalRequest
  | ChatNotice;

export type ChatSessionStatus =
  | "starting"
  | "running"
  | "awaiting_input"
  | "idle"
  | "not_loaded"
  | "offline"
  | "dead";

export interface ChatBackgroundTask {
  id: string;
  kind: "process" | "subagent";
  name: string;
  detail?: string;
  canStop: boolean;
  startedAtMs: number;
}

export interface ChatSessionState {
  status: ChatSessionStatus;
  harness: string;
  title?: string;
  harnessSessionId?: string;
  backgroundTasks?: ChatBackgroundTask[];
}

export interface ChatTurn {
  id: string;
  status: "running" | "completed" | "failed" | "interrupted";
  error?: { message: string };
  startedAtMs: number;
  completedAtMs?: number;
}

export type ChatDurableEvent =
  | { type: "item"; item: ChatItem; turnId: string }
  | { type: "turn"; turn: ChatTurn }
  | { type: "session"; session: ChatSessionState };

export type ChatDeltaChannel = "text" | "tool_input" | "terminal" | "background";

export interface ChatDelta {
  type: ChatDeltaChannel;
  itemId: string;
  append: string;
}

interface ChatEnvelopeBase {
  v: 1;
  sessionId: string;
  ts: number;
}

export type ChatDurableEnvelope = ChatEnvelopeBase & {
  cursor: ChatCursor;
  event: ChatDurableEvent;
};
export type ChatDeltaEnvelope = ChatEnvelopeBase & { delta: ChatDelta };
export type ChatResetEnvelope = ChatEnvelopeBase & { reset: { reason: string } };

export type ChatEnvelope =
  | ChatDurableEnvelope
  | ChatDeltaEnvelope
  | ChatResetEnvelope;

export function parseChatEnvelope(raw: string): ChatEnvelope | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const envelope = value as Record<string, unknown>;
  if (envelope.v !== 1 || typeof envelope.sessionId !== "string") return null;
  if ("event" in envelope) {
    return isCursor(envelope.cursor) && isDurableEvent(envelope.event)
      ? (envelope as unknown as ChatEnvelope)
      : null;
  }
  if ("delta" in envelope) {
    const delta = envelope.delta as Record<string, unknown> | null;
    return delta && typeof delta.itemId === "string" && typeof delta.append === "string"
      ? (envelope as unknown as ChatEnvelope)
      : null;
  }
  if ("reset" in envelope) {
    const reset = envelope.reset as Record<string, unknown> | null;
    return reset && typeof reset.reason === "string" ? (envelope as unknown as ChatEnvelope) : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCursor(value: unknown): boolean {
  return isRecord(value) && typeof value.epoch === "string" && typeof value.seq === "number";
}

function isDurableEvent(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "item":
      return (
        typeof value.turnId === "string" &&
        isRecord(value.item) &&
        typeof value.item.id === "string" &&
        typeof value.item.kind === "string"
      );
    case "turn":
      return (
        isRecord(value.turn) &&
        typeof value.turn.id === "string" &&
        typeof value.turn.status === "string" &&
        typeof value.turn.startedAtMs === "number"
      );
    case "session":
      return isRecord(value.session) && typeof value.session.status === "string";
    default:
      return false;
  }
}

export function isDurableChatEnvelope(
  envelope: ChatEnvelope,
): envelope is ChatDurableEnvelope {
  return "event" in envelope;
}

export function isDeltaChatEnvelope(
  envelope: ChatEnvelope,
): envelope is ChatDeltaEnvelope {
  return "delta" in envelope;
}

export function isResetChatEnvelope(
  envelope: ChatEnvelope,
): envelope is ChatResetEnvelope {
  return "reset" in envelope;
}
