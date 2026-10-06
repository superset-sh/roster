import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgres://roster:roster@127.0.0.1:5432/roster";
});

const { workspaceSurvivedReap } = await import("./supervisor");

const session = (
  over: Partial<{
    supersetWorkspaceId: string | null;
    workspaceReapedAt: Date | null;
  }> = {},
) => ({
  supersetWorkspaceId: "ws_1",
  workspaceReapedAt: null,
  ...over,
});

describe("workspaceSurvivedReap", () => {
  it("flags a workspace the reap never stamped", () => {
    expect(workspaceSurvivedReap(session())).toBe(true);
  });

  it("clears a workspace the reap stamped", () => {
    expect(
      workspaceSurvivedReap(session({ workspaceReapedAt: new Date() })),
    ).toBe(false);
  });

  it("ignores a session that never had a workspace", () => {
    expect(workspaceSurvivedReap(session({ supersetWorkspaceId: null }))).toBe(
      false,
    );
  });

  it("ignores a workspaceless session even if it somehow carries a stamp", () => {
    expect(
      workspaceSurvivedReap(
        session({ supersetWorkspaceId: null, workspaceReapedAt: new Date() }),
      ),
    ).toBe(false);
  });
});
