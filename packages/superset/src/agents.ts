import SuperJSON from "superjson";

import { SupersetError } from "./client";

const RELAY_URL = process.env.SUPERSET_RELAY_URL ?? "https://relay.superset.sh";

export function routingKey(organizationId: string, hostId: string): string {
  return `${organizationId}:${hostId}`;
}

async function unwrap<T>(response: Response, what: string): Promise<T> {
  const raw = await response.text();

  if (!response.ok) {
    throw new SupersetError(
      `${what} failed with ${response.status}: ${raw.slice(0, 300)}`,
      response.status,
    );
  }

  let parsed: { result?: { data?: unknown } };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SupersetError(`${what} returned invalid JSON: ${raw.slice(0, 200)}`);
  }

  const data = parsed.result?.data;
  if (data === undefined) {
    throw new SupersetError(`${what} returned a malformed response.`);
  }
  return SuperJSON.deserialize(
    data as Parameters<typeof SuperJSON.deserialize>[0],
  ) as T;
}

async function call<T>(args: {
  jwt: string;
  routingKey: string;
  procedure: string;
  input: unknown;
  what: string;
  method: "GET" | "POST";
  timeoutMs?: number;
}): Promise<T> {
  const base = `${RELAY_URL}/hosts/${args.routingKey}/trpc/${args.procedure}`;
  const serialized = JSON.stringify(SuperJSON.serialize(args.input));
  const url =
    args.method === "GET"
      ? `${base}?input=${encodeURIComponent(serialized)}`
      : base;

  let response: Response;
  try {
    response = await fetch(url, {
      method: args.method,
      headers: {
        Authorization: `Bearer ${args.jwt}`,
        "Content-Type": "application/json",
      },
      body: args.method === "POST" ? serialized : undefined,
      signal: AbortSignal.timeout(args.timeoutMs ?? 30_000),
    });
  } catch (cause) {
    throw new SupersetError(
      `${args.what} could not reach that machine. ${(cause as Error).message}`,
    );
  }

  return unwrap<T>(response, args.what);
}

export interface CreatedWorkspace {
  id: string;
  name: string;
  branch: string;
}

export async function createWorkspace(args: {
  jwt: string;
  routingKey: string;
  projectId: string;
  namingPrompt: string;
}): Promise<CreatedWorkspace> {
  const result = await call<{ workspace: CreatedWorkspace }>({
    jwt: args.jwt,
    routingKey: args.routingKey,
    procedure: "workspaces.create",
    input: {
      projectId: args.projectId,
      namingPrompt: args.namingPrompt,
      runSetup: false,
    },
    what: "Creating a worktree on that machine",
    method: "POST",
    timeoutMs: 60_000,
  });
  return result.workspace;
}

export async function deleteWorkspace(args: {
  jwt: string;
  routingKey: string;
  workspaceId: string;
}): Promise<void> {
  await call({
    jwt: args.jwt,
    routingKey: args.routingKey,
    procedure: "workspace.delete",
    input: { id: args.workspaceId },
    what: "Removing that worktree",
    method: "POST",
    timeoutMs: 60_000,
  });
}
