import { vi } from "vitest";

import "./fake-chat";
import { runSessionsInThisProcess } from "../services/sessions/dispatch";

runSessionsInThisProcess();

vi.mock("@roster/superset", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@roster/superset")>();
  const { randomUUID } = await import("node:crypto");

  return {
    ...actual,
    createWorkspace: vi.fn(async () => ({
      id: "workspace-1",
      path: "/tmp/workspace-1",
    })),
    deleteWorkspace: vi.fn(async () => undefined),
    createChatSession: vi.fn(async () => ({
      sessionId: `chat-${randomUUID()}`,
      epoch: "epoch-1",
    })),
    promptChat: vi.fn(async () => ({ itemId: randomUUID(), queued: false })),
    getChatSession: vi.fn(async () => ({ session: null, cursor: null, live: true })),
    cancelChatTurn: vi.fn(async () => undefined),
    closeChatSession: vi.fn(async () => undefined),
    respondToChatApproval: vi.fn(async () => undefined),
    stopChatBackgroundTask: vi.fn(async () => true),
    getChatItems: vi.fn(async () => ({ ok: true, envelopes: [], nextBefore: null })),
    chatStreamUrl: vi.fn((args: { sessionId: string }) => `chat://${args.sessionId}`),
    mintJwt: vi.fn(async () => ({ token: "jwt" })),
    listHosts: vi.fn(async () => []),
    listProjects: vi.fn(async () => []),
    listOrganizations: vi.fn(async () => []),
    getOrganization: vi.fn(async () => null),
  };
});

vi.mock("../services/sessions/connection", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/sessions/connection")>();

  return {
    ...actual,
    hostConnection: vi.fn(async () => ({
      jwt: "jwt",
      hostKey: "host-1",
      memberId: "member-1",
      folder: { supersetProjectId: "superset-project" },
    })),
    jwtForMember: vi.fn(async () => ({ jwt: "jwt" })),
  };
});
