import { randomUUID } from "node:crypto";

import {
  db,
  folders,
  members,
  messages,
  organizations,
  projects,
  threads,
  threadSessions,
  users,
} from "@roster/db";
import { eq, sql } from "drizzle-orm";

export interface FixtureThread {
  threadId: string;
  sessionId: string;
  rootMessageId: string;
  projectId: string;
}

export interface Fixture {
  orgId: string;
  userId: string;
  memberId: string;
  projectId: string;
  folderId: string;
  channel(slug: string): Promise<string>;
  folderFor(projectId?: string): string;
  agentFor(projectId?: string): string;
  agent(projectId: string, handle: string, brief?: string): Promise<string>;
  agentInFolder(folderId: string, handle: string, brief?: string): Promise<string>;
  thread(args?: { status?: string; text?: string }): Promise<FixtureThread>;
  cleanup(): Promise<void>;
}

export function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

const WARM_CONNECTIONS = 8;

export async function warmPool(): Promise<void> {
  await Promise.all(
    Array.from({ length: WARM_CONNECTIONS }, () => db.execute(sql`select 1`)),
  );
}

export async function makeFixture(name: string): Promise<Fixture> {
  await warmPool();

  const orgId = randomUUID();
  const userId = randomUUID();
  const memberId = randomUUID();
  const projectId = randomUUID();

  await db.insert(users).values({
    id: userId,
    name,
    email: `${userId}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(organizations).values({
    id: orgId,
    name,
    slug: `${name}-${orgId.slice(0, 8)}`,
    createdAt: new Date(),
  });
  await db.insert(members).values({
    id: memberId,
    organizationId: orgId,
    userId,
    role: "owner",
    createdAt: new Date(),
  });

  const agents = new Map<string, string>();
  const projectFolders = new Map<string, string>();

  async function addProject(id: string, slug: string): Promise<string> {
    const folderId = randomUUID();
    await db.insert(folders).values({
      id: folderId,
      organizationId: orgId,
      supersetProjectId: `superset-${slug}-${id.slice(0, 8)}`,
      supersetHostId: "host-1",
      supersetOrgId: orgId,
      name: slug,
      ownerMemberId: memberId,
    });
    projectFolders.set(id, folderId);

    const agentId = await addAgent(folderId, slug);
    if (!agents.has(id)) agents.set(id, agentId);

    await db.insert(projects).values({
      id,
      organizationId: orgId,
      name: slug,
      slug,
      defaultAgentId: agentId,
      addedByMemberId: memberId,
    });
    return id;
  }

  async function addAgent(
    folderId: string,
    handle: string,
    brief?: string,
  ): Promise<string> {
    const [row] = await db
      .insert(members)
      .values({
        organizationId: orgId,
        userId: null,
        role: "member",
        type: "agent",
        agentName: handle,
        folderId,
        brief: brief ?? null,
      })
      .returning({ id: members.id });

    return row!.id;
  }

  await addProject(projectId, name);

  async function nextSeq(target: string): Promise<number> {
    const [row] = await db
      .update(projects)
      .set({ lastSeq: sql`${projects.lastSeq} + 1` })
      .where(eq(projects.id, target))
      .returning({ lastSeq: projects.lastSeq });
    return row!.lastSeq;
  }

  return {
    orgId,
    userId,
    memberId,
    projectId,
    folderId: projectFolders.get(projectId)!,

    channel: (slug) => addProject(randomUUID(), slug),

    folderFor: (target) => projectFolders.get(target ?? projectId) ?? "",

    agentFor: (target) => agents.get(target ?? projectId) ?? "",

    agent: (target, handle, brief) =>
      addAgent(projectFolders.get(target)!, handle, brief),

    agentInFolder: (folderId, handle, brief) =>
      addAgent(folderId, handle, brief),

    async thread(args = {}) {
      const [root] = await db
        .insert(messages)
        .values({
          organizationId: orgId,
          projectId,
          seq: await nextSeq(projectId),
          authorMemberId: memberId,
          kind: "user",
          body: { type: "doc", content: [] },
          text: args.text ?? "go",
        })
        .returning({ id: messages.id });

      const [thread] = await db
        .insert(threads)
        .values({ organizationId: orgId, projectId, rootMessageId: root!.id })
        .returning({ id: threads.id });

      await db
        .update(messages)
        .set({ threadId: thread!.id })
        .where(eq(messages.id, root!.id));

      const [session] = await db
        .insert(threadSessions)
        .values({
          threadId: thread!.id,
          projectId,
          agentMemberId: agents.get(projectId)!,
          role: "main",
          runAsMemberId: memberId,
          status: args.status ?? "running",
          supersetWorkspaceId: "workspace-1",
          supersetChatSessionId: `chat-${thread!.id}`,
          supersetHostKey: "host-1",
        })
        .returning({ id: threadSessions.id });

      return {
        threadId: thread!.id,
        sessionId: session!.id,
        rootMessageId: root!.id,
        projectId,
      };
    },

    async cleanup() {
      await db.delete(threads).where(eq(threads.organizationId, orgId));
      await db.delete(messages).where(eq(messages.organizationId, orgId));
      await db.delete(projects).where(eq(projects.organizationId, orgId));
      await db
        .update(members)
        .set({ folderId: null })
        .where(eq(members.organizationId, orgId));
      await db.delete(folders).where(eq(folders.organizationId, orgId));
      await db.delete(members).where(eq(members.organizationId, orgId));
      await db.delete(organizations).where(eq(organizations.id, orgId));
      await db.delete(users).where(eq(users.id, userId));
    },
  };
}
