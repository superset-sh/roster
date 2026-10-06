import { randomUUID } from "node:crypto";

import {
  acquireLease,
  closeRedis,
  redis,
  releaseLease,
  renewLease,
} from "@roster/api/redis";
import { closeSweepQueue } from "@roster/api/recurrence";
import {
  cancelThread,
  closeSessionQueue,
  ensureStarted,
  joinThread,
  reapThread,
  retryThread,
  runSessionsInThisProcess,
  startSession,
  steer,
  stopSessions,
} from "@roster/api/sessions";

import { sweepWorker } from "./sweep-worker";
import { supervisorWorker } from "./supervisor-worker";

const LEASE_KEY = "roster:supervisor:owner";
const LEASE_TTL_MS = 30_000;
const RENEW_INTERVAL_MS = 10_000;
const CLAIM_INTERVAL_MS = 5_000;

const workerId = `${process.env.RAILWAY_REPLICA_ID ?? "local"}:${randomUUID().slice(0, 8)}`;

const handlers = {
  startSession,
  joinThread,
  steer,
  cancelThread,
  retryThread,
  reapThread,
} as const;

runSessionsInThisProcess();

let active: Awaited<ReturnType<typeof supervisorWorker>> | null = null;
let sweeper: Awaited<ReturnType<typeof sweepWorker>> | null = null;
let renewTimer: ReturnType<typeof setInterval> | null = null;
let claimTimer: ReturnType<typeof setTimeout> | null = null;
let stopping = false;

async function becomeActive(): Promise<void> {
  console.log(`[worker] ${workerId} holds the supervisor lease`);

  await ensureStarted();
  active = await supervisorWorker(handlers);
  sweeper = await sweepWorker();

  renewTimer = setInterval(() => {
    void keepLease();
  }, RENEW_INTERVAL_MS);
}

async function keepLease(): Promise<void> {
  if (stopping) return;

  const held = await renewLease(
    redis("worker"),
    LEASE_KEY,
    workerId,
    LEASE_TTL_MS,
  ).catch(() => false);

  if (held) return;

  console.warn(`[worker] ${workerId} lost the supervisor lease — standing down`);
  await standDown();
  scheduleClaim();
}

async function standDown(): Promise<void> {
  if (renewTimer) {
    clearInterval(renewTimer);
    renewTimer = null;
  }
  const running = active;
  const sweeping = sweeper;
  active = null;
  sweeper = null;
  if (sweeping) await sweeping.close();
  if (running) await running.close();
  stopSessions();
}

function scheduleClaim(): void {
  if (stopping || claimTimer) return;
  claimTimer = setTimeout(() => {
    claimTimer = null;
    void claim();
  }, CLAIM_INTERVAL_MS);
}

async function claim(): Promise<void> {
  if (stopping || active) return;

  const won = await acquireLease(
    redis("worker"),
    LEASE_KEY,
    workerId,
    LEASE_TTL_MS,
  ).catch(() => false);

  if (won) {
    await becomeActive();
    return;
  }

  scheduleClaim();
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;

  console.log(`[worker] ${signal} — shutting down`);

  if (claimTimer) clearTimeout(claimTimer);
  await standDown();
  await releaseLease(redis("worker"), LEASE_KEY, workerId).catch(() => false);
  await closeSessionQueue();
  await closeSweepQueue();
  await closeRedis();

  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

console.log(`[worker] ${workerId} starting`);
await claim();
if (!active) {
  console.log(`[worker] ${workerId} is standing by for the lease`);
}
