"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface ChatTarget {
  projectId: string;
  channelSlug: string;
  threadId: string;
  title: string;
}

const MAX_OPEN_CHATS = 4;

interface ChatPanelValue {
  orgSlug: string;
  chats: ChatTarget[];
  target: ChatTarget | null;
  openChat: (target: ChatTarget) => void;
  restoreChat: (threadId: string) => void;
  minimizeChat: () => void;
  closeChat: (threadId: string) => void;
}

const ChatPanelContext = createContext<ChatPanelValue | null>(null);

export function ChatPanelProvider({
  orgSlug,
  children,
}: {
  orgSlug: string;
  children: ReactNode;
}) {
  const [chats, setChats] = useState<ChatTarget[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);

  const openChat = useCallback((next: ChatTarget) => {
    setChats((current) => {
      const rest = current.filter((chat) => chat.threadId !== next.threadId);
      return [...rest, next].slice(-MAX_OPEN_CHATS);
    });
    setActiveThreadId(next.threadId);
  }, []);

  const restoreChat = useCallback((threadId: string) => setActiveThreadId(threadId), []);
  const minimizeChat = useCallback(() => setActiveThreadId(null), []);

  const closeChat = useCallback((threadId: string) => {
    setChats((current) => current.filter((chat) => chat.threadId !== threadId));
    setActiveThreadId((current) => (current === threadId ? null : current));
  }, []);

  const target = chats.find((chat) => chat.threadId === activeThreadId) ?? null;

  const value = useMemo<ChatPanelValue>(
    () => ({
      orgSlug,
      chats,
      target,
      openChat,
      restoreChat,
      minimizeChat,
      closeChat,
    }),
    [orgSlug, chats, target, openChat, restoreChat, minimizeChat, closeChat],
  );

  return <ChatPanelContext.Provider value={value}>{children}</ChatPanelContext.Provider>;
}

export function useChatPanel(): ChatPanelValue {
  const value = useContext(ChatPanelContext);
  if (!value) throw new Error("useChatPanel must be used inside a ChatPanelProvider");
  return value;
}
