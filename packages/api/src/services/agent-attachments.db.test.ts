import { beforeAll, describe, expect, it, vi } from "vitest";

import { waitFor } from "../test/fake-chat";
import "../test/mock-superset";

const hasDatabase = Boolean(process.env.DATABASE_URL);

async function promptsSent(atLeast: number): Promise<string[]> {
  const { promptChat } = await import("@roster/superset");
  return waitFor(
    () => vi.mocked(promptChat).mock.calls.map((call) => call[0].text),
    (texts) => texts.length >= atLeast,
  );
}

function png(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 800);
  view.setUint32(20, 600);
  return bytes;
}

describe.skipIf(!hasDatabase)("what an agent session is told about files", () => {
  let api: {
    sendMessage: typeof import("./messages").sendMessage;
    threadIdForMessage: typeof import("./messages").threadIdForMessage;
    uploadAttachment: typeof import("./attachments").uploadAttachment;
    cleanup: () => Promise<void>;
  };

  const ids = {
    org: "",
    user: "",
    member: "",
    project: "",
    attachment: "",
  };

  beforeAll(async () => {
    const { randomUUID } = await import("node:crypto");
    const { db, folders, members, messages, organizations, projects, users } =
      await import("@roster/db");
    const { eq } = await import("drizzle-orm");
    const { sendMessage, threadIdForMessage } = await import("./messages");
    const { uploadAttachment } = await import("./attachments");

    ids.org = randomUUID();
    ids.user = randomUUID();
    ids.member = randomUUID();
    ids.project = randomUUID();

    await db.insert(users).values({
      id: ids.user,
      name: "Brief",
      email: `${ids.user}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(organizations).values({
      id: ids.org,
      name: "Brief",
      slug: `brief-${ids.org.slice(0, 8)}`,
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
      name: "brief",
      ownerMemberId: ids.member,
    });
    const [agent] = await db
      .insert(members)
      .values({
        organizationId: ids.org,
        userId: null,
        role: "member",
        type: "agent",
        agentName: "agent-brief",
        folderId,
        createdAt: new Date(),
      })
      .returning({ id: members.id });
    await db.insert(projects).values({
      id: ids.project,
      organizationId: ids.org,
      name: "brief",
      slug: "brief",
      defaultAgentId: agent!.id,
      addedByMemberId: ids.member,
    });

    const uploaded = await uploadAttachment({
      userId: ids.user,
      projectId: ids.project,
      filename: "Screenshot.png",
      bytes: png(),
    });
    if (!("attachment" in uploaded)) throw new Error("upload refused");
    ids.attachment = uploaded.attachment.id;

    api = {
      sendMessage,
      threadIdForMessage,
      uploadAttachment,
      cleanup: async () => {
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
      },
    };
  });

  it("names them in the prompt that starts the session, and in a steer", async () => {
    try {
      const sent = await api.sendMessage({
        organizationId: ids.org,
        projectId: ids.project,
        authorMemberId: ids.member,
        role: "owner",
        body: { type: "doc", content: [] },
        text: "have a look at this",
        clientId: crypto.randomUUID(),
        attachmentIds: [ids.attachment],
      });

      const prompt = (await promptsSent(1))[0] ?? "";
      expect(prompt).toContain("have a look at this");
      expect(prompt).toContain("Screenshot.png (image/png)");
      expect(prompt).toContain(`/api/files/${ids.attachment}`);
      expect(prompt).toContain("roster files download <url>");
      expect(prompt).not.toContain("ROSTER_TOKEN");

      const threadId = await api.threadIdForMessage(sent.id);
      expect(threadId).toBeTruthy();

      const second = await api.uploadAttachment({
        userId: ids.user,
        projectId: ids.project,
        filename: "spec.pdf",
        bytes: new TextEncoder().encode("%PDF-1.4\nheader is all this needs"),
      });
      if (!("attachment" in second)) throw new Error("upload refused");

      await api.sendMessage({
        organizationId: ids.org,
        projectId: ids.project,
        authorMemberId: ids.member,
        role: "owner",
        body: { type: "doc", content: [] },
        text: "and the spec",
        clientId: crypto.randomUUID(),
        threadId: threadId ?? undefined,
        attachmentIds: [second.attachment.id],
      });

      const steer = (await promptsSent(2))[1] ?? "";
      expect(steer).toContain("and the spec");
      expect(steer).toContain("spec.pdf (application/pdf)");
      expect(steer).toContain(`/api/files/${second.attachment.id}`);
    } finally {
      await api.cleanup();
    }
  }, 30000);
});
