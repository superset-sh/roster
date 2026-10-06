"use client";

import type { ChatEnvelope } from "@roster/api";
import { useCallback, useEffect, useRef, useState } from "react";

import { emptyChatSnapshot, reduceChat, type ChatSnapshot } from "~/utils/chat-session";
import { trpc } from "~/utils/trpc";

export type ChatConnection = "connecting" | "open" | "unavailable";

const MAX_FAILED_CONNECTS = 3;
const UNAVAILABLE_RETRY_MS = 15_000;

export function useThreadChat(args: {
  orgSlug: string;
  projectId: string;
  threadId: string;
  enabled: boolean;
}) {
  const { orgSlug, projectId, threadId, enabled } = args;
  const [snapshot, setSnapshot] = useState<ChatSnapshot>(emptyChatSnapshot);
  const [connection, setConnection] = useState<ChatConnection>("connecting");
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [reachedStart, setReachedStart] = useState(false);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  useEffect(() => {
    if (!enabled) return;

    setSnapshot(emptyChatSnapshot());
    setReachedStart(false);
    setConnection("connecting");

    const query = new URLSearchParams({ slug: orgSlug, projectId, threadId });
    let source: EventSource | null = null;
    let disposed = false;
    let failures = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let pending: ChatEnvelope[] = [];
    let frame: number | null = null;

    const flush = () => {
      frame = null;
      const batch = pending;
      pending = [];
      setSnapshot((previous) => reduceChat(previous, batch));
    };

    const connect = () => {
      if (disposed) return;
      let opened = false;
      source = new EventSource(`/api/chat/stream?${query.toString()}`);

      source.addEventListener("ready", () => setConnection("open"));

      source.onmessage = (event: MessageEvent<string>) => {
        opened = true;
        failures = 0;
        let envelope: ChatEnvelope;
        try {
          envelope = JSON.parse(event.data) as ChatEnvelope;
        } catch {
          return;
        }
        pending.push(envelope);
        frame ??= requestAnimationFrame(flush);
      };

      source.onerror = () => {
        source?.close();
        source = null;
        if (disposed) return;
        failures = opened ? 0 : failures + 1;
        if (failures >= MAX_FAILED_CONNECTS) setConnection("unavailable");
        else setConnection("connecting");
        retry = setTimeout(connect, Math.min(1000 * 2 ** failures, UNAVAILABLE_RETRY_MS));
      };
    };

    connect();

    return () => {
      disposed = true;
      source?.close();
      if (retry) clearTimeout(retry);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [enabled, orgSlug, projectId, threadId]);

  const loadOlder = useCallback(async () => {
    const before = snapshotRef.current.oldest;
    if (!before || loadingOlder || reachedStart) return;
    setLoadingOlder(true);
    try {
      const page = await trpc.chat.items.query({ projectId, threadId, before });
      if (!page.ok || page.envelopes.length === 0) {
        setReachedStart(true);
        return;
      }
      setSnapshot((previous) => reduceChat(previous, page.envelopes));
      if (!page.nextBefore) setReachedStart(true);
    } catch {
      console.warn("[chat] loading older messages failed");
    } finally {
      setLoadingOlder(false);
    }
  }, [projectId, threadId, loadingOlder, reachedStart]);

  return { snapshot, connection, loadOlder, loadingOlder, reachedStart };
}
