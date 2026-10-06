"use client";

import { Button, cn } from "@roster/ui";
import { ArrowUp, Square } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";

export interface ChatComposerProps {
  running: boolean;
  disabled?: boolean;
  placeholder: string;
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
}

const MAX_HEIGHT = 160;

export function ChatComposer({ running, disabled, placeholder, onSend, onStop }: ChatComposerProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  const resize = () => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`;
  };

  async function send() {
    const value = text.trim();
    if (value.length === 0 || sending) return;
    setSending(true);
    const sent = await onSend(value);
    setSending(false);
    if (!sent) return;
    setText("");
    requestAnimationFrame(resize);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  const canSend = text.trim().length > 0 && !sending && !disabled;

  return (
    <div className="bg-background-3 border-border focus-within:border-foreground/30 rounded-xl border px-3 pt-2.5 pb-2 transition-colors">
      <textarea
        ref={ref}
        rows={1}
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => {
          setText(event.target.value);
          resize();
        }}
        onKeyDown={onKeyDown}
        className="placeholder:text-muted-foreground w-full resize-none bg-transparent text-sm outline-none disabled:opacity-60"
      />
      <div className="flex items-center justify-end gap-1">
        {running ? (
          <Button
            variant="ghost"
            size="xs"
            aria-label="Stop the agent"
            className="text-muted-foreground !rounded-full px-1.5"
            onClick={onStop}
          >
            <Square size={12} className="fill-current" />
          </Button>
        ) : null}
        <Button
          size="xs"
          aria-label="Send"
          disabled={!canSend}
          isLoading={sending}
          className={cn("!size-6 !rounded-full p-0", !canSend && "opacity-40")}
          onClick={() => void send()}
        >
          {sending ? null : <ArrowUp size={13} />}
        </Button>
      </div>
    </div>
  );
}
