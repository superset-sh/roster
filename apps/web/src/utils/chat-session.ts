import type {
  ChatCursor,
  ChatEnvelope,
  ChatItem,
  ChatSessionState,
  ChatTurn,
} from "@roster/api";

export interface ChatSnapshot {
  session: ChatSessionState | null;
  items: ReadonlyMap<string, { item: ChatItem; turnId: string; seq: number }>;
  turns: ReadonlyMap<string, ChatTurn>;
  liveText: ReadonlyMap<string, string>;
  backgroundDetail: ReadonlyMap<string, string>;
  oldest: ChatCursor | null;
}

export function emptyChatSnapshot(): ChatSnapshot {
  return {
    session: null,
    items: new Map(),
    turns: new Map(),
    liveText: new Map(),
    backgroundDetail: new Map(),
    oldest: null,
  };
}

export function reduceChat(
  previous: ChatSnapshot,
  envelopes: readonly ChatEnvelope[],
): ChatSnapshot {
  if (envelopes.length === 0) return previous;

  let session = previous.session;
  let oldest = previous.oldest;
  let items: Map<string, { item: ChatItem; turnId: string; seq: number }> | null = null;
  let turns: Map<string, ChatTurn> | null = null;
  let liveText: Map<string, string> | null = null;
  let backgroundDetail: Map<string, string> | null = null;

  for (const envelope of envelopes) {
    if ("reset" in envelope) continue;

    if ("delta" in envelope) {
      const { delta } = envelope;
      if (delta.type === "background") {
        backgroundDetail ??= new Map(previous.backgroundDetail);
        backgroundDetail.set(delta.itemId, delta.append);
        continue;
      }
      if (delta.type !== "text") continue;
      liveText ??= new Map(previous.liveText);
      const current = (items ?? previous.items).get(delta.itemId)?.item;
      const base =
        liveText.get(delta.itemId) ??
        (current && "text" in current && typeof current.text === "string"
          ? current.text
          : "");
      liveText.set(delta.itemId, base + delta.append);
      continue;
    }

    const { cursor, event } = envelope;
    if (!oldest || (oldest.epoch === cursor.epoch && cursor.seq < oldest.seq)) {
      oldest = cursor;
    }

    if (event.type === "session") {
      session = event.session;
    } else if (event.type === "turn") {
      turns ??= new Map(previous.turns);
      turns.set(event.turn.id, event.turn);
    } else {
      items ??= new Map(previous.items);
      const existing = items.get(event.item.id);
      items.set(event.item.id, {
        item: event.item,
        turnId: event.turnId,
        seq: existing ? Math.min(existing.seq, cursor.seq) : cursor.seq,
      });
      if ((liveText ?? previous.liveText).has(event.item.id)) {
        liveText ??= new Map(previous.liveText);
        liveText.delete(event.item.id);
      }
    }
  }

  return {
    session,
    items: items ?? previous.items,
    turns: turns ?? previous.turns,
    liveText: liveText ?? previous.liveText,
    backgroundDetail: backgroundDetail ?? previous.backgroundDetail,
    oldest,
  };
}

export function orderedItems(snapshot: ChatSnapshot): { item: ChatItem; turnId: string }[] {
  return [...snapshot.items.values()].sort((a, b) => a.seq - b.seq);
}

export function itemText(snapshot: ChatSnapshot, item: ChatItem): string {
  const live = snapshot.liveText.get(item.id);
  if (live !== undefined) return live;
  return "text" in item && typeof item.text === "string" ? item.text : "";
}

export function runningTurn(snapshot: ChatSnapshot): ChatTurn | null {
  for (const turn of snapshot.turns.values()) {
    if (turn.status === "running") return turn;
  }
  return null;
}

const ROSTER_ENVELOPE = /<roster>[\s\S]*?<\/roster>\s*/g;

export function visibleUserText(item: ChatItem): string {
  if (item.kind !== "user_message") return "";
  return item.content
    .map((content) => (content.type === "text" ? content.text : `📎 ${content.name}`))
    .join("\n")
    .replace(ROSTER_ENVELOPE, "")
    .trim();
}

export function hadRosterBrief(item: ChatItem): boolean {
  if (item.kind !== "user_message") return false;
  return item.content.some(
    (content) => content.type === "text" && content.text.includes("<roster>"),
  );
}
