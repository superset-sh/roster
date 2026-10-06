"use client";

import type { ThreadBackgroundWork as BackgroundWork } from "@roster/api";
import { cn } from "@roster/ui";
import { Bot, Loader2, Square, SquareTerminal } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { trpc } from "~/utils/trpc";

export function MenuGroup({
  title,
  actions,
  children,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="py-1">
      <div className="flex h-7 items-center justify-between pr-1 pl-2">
        <span className="text-muted-foreground text-[11px] font-medium">{title}</span>
        <span className="flex items-center gap-0.5">{actions}</span>
      </div>
      {children}
    </section>
  );
}

export function EmptyRow({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground/70 px-2 py-1.5 text-xs">{children}</p>;
}

function age(startedAtMs: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - startedAtMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function workKey(task: BackgroundWork): string {
  return `${task.rosterSessionId}:${task.id}`;
}

export function useStopBackgroundWork(projectId: string, threadId: string) {
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());

  async function stop(tasks: BackgroundWork[]) {
    const keys = tasks.map(workKey);
    setStopping((current) => new Set([...current, ...keys]));
    await Promise.all(
      tasks.map((task) =>
        trpc.chat.stopTask
          .mutate({
            projectId,
            threadId,
            rosterSessionId: task.rosterSessionId,
            taskId: task.id,
          })
          .catch(() => console.warn("[chat] stop background task failed")),
      ),
    );
    setStopping((current) => {
      const next = new Set(current);
      for (const key of keys) next.delete(key);
      return next;
    });
  }

  return { stopping, stop, isStopping: (task: BackgroundWork) => stopping.has(workKey(task)) };
}

export function BackgroundWorkRow({
  task,
  detail,
  now,
  stopping,
  onStop,
}: {
  task: BackgroundWork;
  detail: string | undefined;
  now: number;
  stopping: boolean;
  onStop: () => void;
}) {
  const Icon = task.kind === "subagent" ? Bot : SquareTerminal;
  const label = task.name || (task.kind === "subagent" ? "Subagent" : "Background task");

  return (
    <div
      className={cn(
        "hover:bg-accent group flex items-center gap-2 rounded-sm px-2 py-1.5 text-xs transition-colors",
        stopping && "opacity-50",
      )}
    >
      <Icon className="text-muted-foreground size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="text-foreground block truncate">{label}</span>
        {detail ? (
          <span className="text-muted-foreground block truncate text-[11px]">{detail}</span>
        ) : null}
      </span>
      <span className="text-muted-foreground/70 shrink-0 text-[11px] tabular-nums">
        {age(task.startedAtMs, now)}
      </span>
      {task.canStop ? (
        <button
          type="button"
          aria-label={`Stop ${label}`}
          title="Stop"
          disabled={stopping}
          onClick={onStop}
          className="text-muted-foreground hover:bg-background hover:text-foreground flex size-5 shrink-0 items-center justify-center rounded disabled:pointer-events-none"
        >
          {stopping ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Square className="size-2.5 fill-current" />
          )}
        </button>
      ) : null}
    </div>
  );
}

export function BackgroundWorkGroups({
  projectId,
  threadId,
  work,
  details,
  showEmpty = true,
}: {
  projectId: string;
  threadId: string;
  work: BackgroundWork[];
  details?: ReadonlyMap<string, string>;
  showEmpty?: boolean;
}) {
  const now = useNow(1000);
  const { stop, isStopping } = useStopBackgroundWork(projectId, threadId);
  const processes = work.filter((task) => task.kind === "process");
  const subagents = work.filter((task) => task.kind === "subagent");
  const stoppable = processes.filter((task) => task.canStop && !isStopping(task));

  const rows = (tasks: BackgroundWork[]) =>
    tasks.map((task) => (
      <BackgroundWorkRow
        key={workKey(task)}
        task={task}
        detail={details?.get(task.id) ?? task.detail}
        now={now}
        stopping={isStopping(task)}
        onStop={() => void stop([task])}
      />
    ));

  return (
    <>
      {processes.length > 0 || showEmpty ? (
        <MenuGroup
          title="Background processes"
          actions={
            stoppable.length > 0 ? (
              <button
                type="button"
                aria-label="Stop all background processes"
                title="Stop all background processes"
                onClick={() => void stop(stoppable)}
                className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-6 items-center justify-center rounded-sm transition-colors"
              >
                <Square className="size-3 fill-current" />
              </button>
            ) : null
          }
        >
          <div className="max-h-48 overflow-y-auto">
            {processes.length > 0 ? rows(processes) : <EmptyRow>Nothing running</EmptyRow>}
          </div>
        </MenuGroup>
      ) : null}
      {subagents.length > 0 ? (
        <MenuGroup title="Subagents">
          <div className="max-h-48 overflow-y-auto">{rows(subagents)}</div>
        </MenuGroup>
      ) : null}
    </>
  );
}
