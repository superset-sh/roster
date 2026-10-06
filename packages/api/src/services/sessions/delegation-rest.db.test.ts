import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@roster/superset", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@roster/superset")>()),
  createWorkspace: vi.fn(async () => ({ id: "workspace-1" })),
  deleteWorkspace: vi.fn(async () => undefined),
  mintJwt: vi.fn(async () => ({ jwt: "jwt" })),
}));

const hasDatabase = Boolean(process.env.DATABASE_URL);

/*
 * Whether a session may rest at idle turns on one thing: does its thread owe
 * an answer to a thread that asked for one? Completing is what settles that
 * delegation, so a session that owes an answer has to end. Everything else
 * rests. Getting this backwards would hang every `roster ask` forever, so it
 * is worth proving against a real delegations table rather than a stub.
 */
describe.skipIf(!hasDatabase)("which sessions may rest at idle", () => {
  const ids = {
    org: "",
    user: "",
    member: "",
    project: "",
    plainThread: "",
    askedThread: "",
    agent: "",
  };

  let answersDelegation: (args: {
    threadId: string;
    agentMemberId?: string;
  }) => Promise<boolean>;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const { randomUUID } = await import("node:crypto");
    const {
      db,
      delegations,
      folders,
      members,
      messages,
      organizations,
      projects,
      threads,
      users,
    } = await import("@roster/db");
    const { eq } = await import("drizzle-orm");

    ids.org = randomUUID();
    ids.user = randomUUID();
    ids.member = randomUUID();
    ids.project = randomUUID();
    ids.plainThread = randomUUID();
    ids.askedThread = randomUUID();
    ids.agent = randomUUID();

    await db.insert(users).values({
      id: ids.user,
      name: "Rest",
      email: `${ids.user}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(organizations).values({
      id: ids.org,
      name: "Rest",
      slug: `rest-${ids.org.slice(0, 8)}`,
      createdAt: new Date(),
    });
    await db.insert(members).values({
      id: ids.member,
      organizationId: ids.org,
      userId: ids.user,
      role: "owner",
      createdAt: new Date(),
    });
    const folderId = randomUUID();
    await db.insert(folders).values({
      id: folderId,
      organizationId: ids.org,
      supersetProjectId: "superset-project",
      supersetHostId: "host-1",
      supersetOrgId: ids.org,
      name: "rest",
      ownerMemberId: ids.member,
    });
    await db.insert(members).values({
      id: ids.agent,
      organizationId: ids.org,
      userId: null,
      role: "member",
      type: "agent",
      agentName: "agent-rest",
      folderId,
      createdAt: new Date(),
    });
    await db.insert(projects).values({
      id: ids.project,
      organizationId: ids.org,
      name: "rest",
      slug: "rest",
      defaultAgentId: ids.agent,
      addedByMemberId: ids.member,
    });

    let seq = 0;
    const thread = async (threadId: string) => {
      const messageId = randomUUID();
      seq += 1;
      await db.insert(messages).values({
        id: messageId,
        organizationId: ids.org,
        projectId: ids.project,
        seq,
        authorMemberId: ids.member,
        kind: "user",
        body: { type: "doc", content: [] },
        text: "do a thing",
        threadId,
      });
      await db.insert(threads).values({
        id: threadId,
        organizationId: ids.org,
        projectId: ids.project,
        rootMessageId: messageId,
      });
    };

    await thread(ids.plainThread);
    await thread(ids.askedThread);

    await db.insert(delegations).values({
      organizationId: ids.org,
      parentThreadId: ids.plainThread,
      originMemberId: ids.agent,
      targetMemberId: ids.agent,
      childThreadId: ids.askedThread,
      task: "what is the auth flow?",
      status: "open",
    });

    ({ answersDelegation } = await import("./supervisor"));

    cleanup = async () => {
      await db
        .delete(delegations)
        .where(eq(delegations.organizationId, ids.org));
      await db.delete(threads).where(eq(threads.organizationId, ids.org));
      await db.delete(messages).where(eq(messages.organizationId, ids.org));
      await db.delete(projects).where(eq(projects.id, ids.project));
      await db
        .update(members)
        .set({ folderId: null })
        .where(eq(members.organizationId, ids.org));
      await db.delete(folders).where(eq(folders.organizationId, ids.org));
      await db.delete(members).where(eq(members.organizationId, ids.org));
      await db.delete(organizations).where(eq(organizations.id, ids.org));
      await db.delete(users).where(eq(users.id, ids.user));
    };
  });

  it("lets a thread nobody is waiting on rest", async () => {
    expect(await answersDelegation({ threadId: ids.plainThread })).toBe(false);
  });

  it("holds a thread that owes another thread an answer", async () => {
    expect(await answersDelegation({ threadId: ids.askedThread })).toBe(true);
  });

  it("lets it rest once the delegation has been answered", async () => {
    try {
      const { db, delegations } = await import("@roster/db");
      const { eq } = await import("drizzle-orm");

      await db
        .update(delegations)
        .set({ status: "answered", answeredAt: new Date() })
        .where(eq(delegations.childThreadId, ids.askedThread));

      expect(await answersDelegation({ threadId: ids.askedThread })).toBe(false);
    } finally {
      await cleanup();
    }
  });
});
