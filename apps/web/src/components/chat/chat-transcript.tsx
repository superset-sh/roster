"use client";

import type {
  ChatApprovalRequest,
  ChatItem,
  ChatPlan,
  ChatToolCall,
  ChatToolContent,
} from "@roster/api";
import {
  Button,
  cn,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@roster/ui";
import {
  Bot,
  Check,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  Circle,
  FileText,
  Globe,
  Pencil,
  Search,
  ShieldQuestion,
  SquareTerminal,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  type ChatSnapshot,
  hadRosterBrief,
  itemText,
  orderedItems,
  visibleUserText,
} from "~/utils/chat-session";

import { ChatMarkdown } from "./chat-markdown";

export interface ChatTranscriptProps {
  snapshot: ChatSnapshot;
  onAnswer: (approval: ChatApprovalRequest, allow: boolean, optionId?: string) => void;
}

export function ChatTranscript({ snapshot, onAnswer }: ChatTranscriptProps) {
  const { topLevel, children } = useMemo(() => {
    const topLevel: ChatItem[] = [];
    const children = new Map<string, ChatItem[]>();
    for (const { item } of orderedItems(snapshot)) {
      if (item.parentItemId) {
        const list = children.get(item.parentItemId) ?? [];
        list.push(item);
        children.set(item.parentItemId, list);
      } else {
        topLevel.push(item);
      }
    }
    return { topLevel, children };
  }, [snapshot]);

  return (
    <div className="flex flex-col gap-1.5">
      {topLevel.map((item) => (
        <ChatRow
          key={item.id}
          item={item}
          snapshot={snapshot}
          nested={children.get(item.id) ?? []}
          onAnswer={onAnswer}
        />
      ))}
    </div>
  );
}

function ChatRow({
  item,
  snapshot,
  nested,
  onAnswer,
}: {
  item: ChatItem;
  snapshot: ChatSnapshot;
  nested: ChatItem[];
  onAnswer: ChatTranscriptProps["onAnswer"];
}) {
  switch (item.kind) {
    case "user_message":
      return <UserRow item={item} />;
    case "agent_message": {
      const text = itemText(snapshot, item);
      if (text.trim().length === 0) return null;
      return <ChatMarkdown text={text} className="py-0.5" />;
    }
    case "reasoning":
      return <ReasoningRow text={itemText(snapshot, item)} />;
    case "tool_call":
      return <ToolRow item={item} nested={nested} snapshot={snapshot} />;
    case "plan":
      return <PlanRow item={item} />;
    case "approval_request":
      return <ApprovalRow item={item} onAnswer={onAnswer} />;
    case "notice":
      return item.text ? (
        <p
          className={cn(
            "py-0.5 text-xs",
            item.noticeKind === "error" ? "text-red-500" : "text-muted-foreground",
          )}
        >
          {item.text}
        </p>
      ) : null;
    default:
      return null;
  }
}

function UserRow({ item }: { item: ChatItem }) {
  const text = visibleUserText(item);
  const briefed = hadRosterBrief(item);
  if (text.length === 0 && !briefed) return null;

  return (
    <div className="flex flex-col items-end gap-0.5 py-1">
      {briefed ? (
        <span className="text-muted-foreground/70 text-[11px]">Roster brief attached</span>
      ) : null}
      {text.length > 0 ? (
        <div className="bg-grayAlpha-100 max-w-[85%] rounded-xl rounded-br-sm px-3 py-1.5 text-sm whitespace-pre-wrap break-words">
          {text}
        </div>
      ) : null}
    </div>
  );
}

function ReasoningRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (text.trim().length === 0) return null;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="text-muted-foreground/70 hover:text-foreground flex items-center gap-1.5 py-0.5 text-xs">
        <ChevronRight size={12} className={cn("transition-transform", open && "rotate-90")} />
        Thought
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="text-muted-foreground border-border/60 mt-1 ml-1.5 border-l pl-3 text-xs whitespace-pre-wrap">
          {text}
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}

function toolIcon(item: ChatToolCall) {
  if (item.subagent) return Bot;
  switch (item.toolKind) {
    case "read":
      return FileText;
    case "edit":
    case "move":
      return Pencil;
    case "delete":
      return Trash2;
    case "search":
      return Search;
    case "execute":
      return SquareTerminal;
    case "fetch":
      return Globe;
    default:
      return Wrench;
  }
}

function ToolRow({
  item,
  nested,
  snapshot,
}: {
  item: ChatToolCall;
  nested: ChatItem[];
  snapshot: ChatSnapshot;
}) {
  const [open, setOpen] = useState(false);
  const running = item.status === "running";
  const Icon = toolIcon(item);
  const hasBody = item.content.length > 0 || nested.length > 0;
  const failed = item.status === "failed" || item.status === "declined";

  return (
    <Collapsible open={hasBody && open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        disabled={!hasBody}
        className={cn(
          "group/tool flex w-full min-w-0 items-center gap-1.5 py-0.5 text-left text-[13px] transition-colors",
          running ? "text-muted-foreground" : "text-foreground/55 enabled:hover:text-foreground/80",
        )}
      >
        {running ? (
          <CircleDashed size={13} className="text-foreground/40 shrink-0 animate-spin" />
        ) : (
          <Icon size={13} className="text-foreground/45 shrink-0" />
        )}
        <span
          className={cn(
            "min-w-0 truncate",
            item.toolKind === "execute" && "font-mono text-[12px]",
            running && "animate-pulse",
          )}
        >
          {item.subagent ? `Subagent · ${item.title}` : item.title}
        </span>
        {failed ? <span className="shrink-0 text-xs text-red-500">{item.status}</span> : null}
        {nested.length > 0 ? (
          <span className="text-muted-foreground/70 shrink-0 text-xs">
            {nested.length} step{nested.length === 1 ? "" : "s"}
          </span>
        ) : null}
        {hasBody ? (
          <ChevronRight
            size={12}
            className={cn(
              "text-foreground/45 shrink-0 opacity-0 transition group-hover/tool:opacity-100",
              open && "rotate-90 opacity-100",
            )}
          />
        ) : null}
      </CollapsibleTrigger>
      {hasBody ? (
        <CollapsibleContent>
          <div className="border-border/60 mt-1 mb-1.5 ml-[6px] flex flex-col gap-1.5 border-l pl-3">
            {item.content.map((content, index) => (
              <ToolContentView key={index} content={content} />
            ))}
            {nested.map((child) =>
              child.kind === "tool_call" ? (
                <ToolRow key={child.id} item={child} nested={[]} snapshot={snapshot} />
              ) : child.kind === "agent_message" ? (
                <ChatMarkdown key={child.id} text={itemText(snapshot, child)} className="text-xs" />
              ) : null,
            )}
          </div>
        </CollapsibleContent>
      ) : null}
    </Collapsible>
  );
}

function ToolContentView({ content }: { content: ChatToolContent }) {
  if (content.type === "text") {
    return (
      <pre className="text-muted-foreground max-h-48 overflow-auto font-mono text-[11px] whitespace-pre-wrap">
        {content.text}
      </pre>
    );
  }
  if (content.type === "terminal") {
    return (
      <div className="bg-grayAlpha-100 max-h-56 overflow-auto rounded-md p-2 font-mono text-[11px]">
        <div className="text-foreground/80">$ {content.command}</div>
        <pre className="text-muted-foreground whitespace-pre-wrap">{content.output}</pre>
      </div>
    );
  }
  return <DiffView path={content.path} oldText={content.oldText} newText={content.newText} />;
}

function DiffView({
  path,
  oldText,
  newText,
}: {
  path: string;
  oldText: string | null;
  newText: string;
}) {
  const lines = useMemo(
    () => changedLines((oldText ?? "").split("\n"), newText.split("\n")).slice(0, MAX_DIFF_LINES),
    [oldText, newText],
  );

  return (
    <div className="bg-grayAlpha-100 overflow-hidden rounded-md">
      <div className="text-muted-foreground border-border/60 border-b px-2 py-1 font-mono text-[11px]">
        {path}
      </div>
      <pre className="max-h-56 overflow-auto p-2 font-mono text-[11px]">
        {lines.map((line, index) => (
          <div
            key={index}
            className={line.startsWith("+") ? "text-green-600" : "text-red-500"}
          >
            {line}
          </div>
        ))}
      </pre>
    </div>
  );
}

function PlanRow({ item }: { item: ChatPlan }) {
  return (
    <div className="border-border/70 my-1 flex flex-col gap-1 rounded-md border px-2.5 py-2">
      <span className="text-muted-foreground text-xs font-medium">Plan</span>
      {item.entries.map((entry, index) => (
        <div key={index} className="flex items-start gap-1.5 text-[13px]">
          {entry.status === "completed" ? (
            <CircleCheck size={13} className="mt-0.5 shrink-0 text-green-600" />
          ) : entry.status === "in_progress" ? (
            <CircleDashed size={13} className="text-foreground/60 mt-0.5 shrink-0 animate-spin" />
          ) : (
            <Circle size={13} className="text-foreground/30 mt-0.5 shrink-0" />
          )}
          <span className={cn(entry.status === "completed" && "text-muted-foreground line-through")}>
            {entry.text}
          </span>
        </div>
      ))}
    </div>
  );
}

function ApprovalRow({
  item,
  onAnswer,
}: {
  item: ChatApprovalRequest;
  onAnswer: ChatTranscriptProps["onAnswer"];
}) {
  const pending = item.status === "pending";
  const options = item.options ?? [];

  return (
    <div
      className={cn(
        "my-1 flex flex-col gap-2 rounded-lg border px-3 py-2",
        pending ? "border-amber-400/60 bg-amber-50/40 dark:bg-amber-500/5" : "border-border/70",
      )}
    >
      <div className="flex items-start gap-2 text-[13px]">
        <ShieldQuestion size={14} className="mt-0.5 shrink-0 text-amber-500" />
        <span className="min-w-0 break-words">{item.title}</span>
      </div>
      {item.detail?.map((content, index) => (
        <ToolContentView key={index} content={content} />
      ))}
      {pending ? (
        <div className="flex flex-wrap gap-1.5">
          {options.length > 0 ? (
            options.map((option) => {
              const allow = option.kind?.startsWith("allow") ?? false;
              return (
                <Button
                  key={option.optionId}
                  size="xs"
                  variant={allow ? "default" : "outline"}
                  className="px-2 text-xs"
                  onClick={() => onAnswer(item, allow, option.optionId)}
                >
                  {option.label}
                </Button>
              );
            })
          ) : (
            <>
              <Button size="xs" className="px-2 text-xs" onClick={() => onAnswer(item, true)}>
                <Check size={12} className="mr-1" /> Allow
              </Button>
              <Button
                size="xs"
                variant="outline"
                className="px-2 text-xs"
                onClick={() => onAnswer(item, false)}
              >
                <X size={12} className="mr-1" /> Deny
              </Button>
            </>
          )}
        </div>
      ) : (
        <span className="text-muted-foreground text-xs">
          {item.status === "answered" ? "Answered" : "No longer needed"}
        </span>
      )}
    </div>
  );
}

const MAX_DIFF_LINES = 200;
const MAX_DIFF_CELLS = 250_000;

function changedLines(before: string[], after: string[]): string[] {
  if (before.length * after.length > MAX_DIFF_CELLS) {
    return [...before.map((line) => `- ${line}`), ...after.map((line) => `+ ${line}`)];
  }
  const common = before.map(() => new Array<number>(after.length + 1).fill(0));
  common.push(new Array<number>(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      common[i]![j] =
        before[i] === after[j]
          ? common[i + 1]![j + 1]! + 1
          : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
    }
  }
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      i += 1;
      j += 1;
    } else if (j < after.length && (i >= before.length || common[i]![j + 1]! >= common[i + 1]![j]!)) {
      lines.push(`+ ${after[j]}`);
      j += 1;
    } else {
      lines.push(`- ${before[i]}`);
      i += 1;
    }
  }
  return lines;
}
