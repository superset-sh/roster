import { ask, type SessionCommands, tell } from "./commands";
import * as supervisor from "./supervisor";

let here = false;

export function runSessionsInThisProcess(): void {
  here = true;
}

export function sessionsRunHere(): boolean {
  return here;
}

export function stopSessions(): void {
  if (here) supervisor.stopAllChatWatches();
}

export function ensureStarted(): Promise<void> {
  if (!here) return Promise.resolve();
  return supervisor.ensureStarted();
}

export async function startSession(
  args: SessionCommands["startSession"],
): Promise<void> {
  if (here) return supervisor.startSession(args);
  await tell("startSession", args);
}

export async function joinThread(
  args: SessionCommands["joinThread"],
): Promise<boolean> {
  if (here) return supervisor.joinThread(args);
  return ask<"joinThread", boolean>("joinThread", args);
}

export async function steer(args: SessionCommands["steer"]): Promise<void> {
  if (here) return supervisor.steer(args);
  await tell("steer", args);
}

export async function cancelThread(
  args: SessionCommands["cancelThread"],
): Promise<boolean> {
  if (here) return supervisor.cancelThread(args);
  return ask<"cancelThread", boolean>("cancelThread", args);
}

export async function retryThread(
  args: SessionCommands["retryThread"],
): Promise<boolean> {
  if (here) return supervisor.retryThread(args);
  return ask<"retryThread", boolean>("retryThread", args);
}

export async function reapThread(
  args: SessionCommands["reapThread"],
): Promise<void> {
  if (here) return supervisor.reapThread(args);
  await ask<"reapThread", void>("reapThread", args);
}
