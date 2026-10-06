import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { requireOrgProject } from "../services/channels";
import {
  assertReaped,
  cancelThread,
  completeThread,
  countOpenWorktrees,
  listChannelThreads,
  listInboxThreads,
  listLiveThreads,
  reapThread,
  retryThread,
  threadDetail,
  threadReferences,
  threadSummary,
  threadTarget,
} from "../services/sessions";
import { createTRPCRouter, memberProcedure } from "../trpc";

export const threadsRouter = createTRPCRouter({
  list: memberProcedure
    .input(z.object({ projectId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const project = await requireOrgProject({
        organizationId: ctx.organizationId,
        memberId: ctx.member.id,
        role: ctx.member.role,
        projectId: input.projectId,
      });
      if (!project) throw new TRPCError({ code: "NOT_FOUND" });

      return listChannelThreads({
        projectId: project.id,
        memberId: ctx.member.id,
      });
    }),

  live: memberProcedure.query(({ ctx }) =>
    listLiveThreads({
      organizationId: ctx.organizationId,
      memberId: ctx.member.id,
      role: ctx.member.role,
    }),
  ),

  openWorktrees: memberProcedure.query(({ ctx }) =>
    countOpenWorktrees({
      organizationId: ctx.organizationId,
      memberId: ctx.member.id,
      role: ctx.member.role,
    }),
  ),

  inbox: memberProcedure.query(({ ctx }) =>
    listInboxThreads({
      organizationId: ctx.organizationId,
      memberId: ctx.member.id,
      role: ctx.member.role,
    }),
  ),

  get: memberProcedure
    .input(
      z.object({
        projectId: z.string().uuid(),
        threadId: z.string().uuid(),
        before: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const project = await requireOrgProject({
        organizationId: ctx.organizationId,
        memberId: ctx.member.id,
        role: ctx.member.role,
        projectId: input.projectId,
      });
      if (!project) throw new TRPCError({ code: "NOT_FOUND" });

      const detail = await threadDetail({
        projectId: project.id,
        threadId: input.threadId,
        before: input.before,
        limit: input.limit,
      });
      if (!detail) throw new TRPCError({ code: "NOT_FOUND" });

      return detail;
    }),

  references: memberProcedure
    .input(
      z.object({
        projectId: z.string().uuid(),
        threadId: z.string().uuid(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const project = await requireOrgProject({
        organizationId: ctx.organizationId,
        memberId: ctx.member.id,
        role: ctx.member.role,
        projectId: input.projectId,
      });
      if (!project) throw new TRPCError({ code: "NOT_FOUND" });

      return threadReferences({
        projectId: project.id,
        threadId: input.threadId,
      });
    }),

  cancel: memberProcedure
    .input(
      z.object({
        projectId: z.string().uuid(),
        threadId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const project = await requireOrgProject({
        organizationId: ctx.organizationId,
        memberId: ctx.member.id,
        role: ctx.member.role,
        projectId: input.projectId,
      });
      if (!project) throw new TRPCError({ code: "NOT_FOUND" });

      const target = await threadTarget(input.threadId);
      if (!target || target.projectId !== project.id) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      const canceled = await cancelThread({ threadId: target.id });
      if (!canceled) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "That session already finished.",
        });
      }

      return threadSummary({ projectId: project.id, threadId: target.id });
    }),

  complete: memberProcedure
    .input(
      z.object({
        projectId: z.string().uuid(),
        threadId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const project = await requireOrgProject({
        organizationId: ctx.organizationId,
        memberId: ctx.member.id,
        role: ctx.member.role,
        projectId: input.projectId,
      });
      if (!project) throw new TRPCError({ code: "NOT_FOUND" });

      const target = await threadTarget(input.threadId);
      if (!target || target.projectId !== project.id) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      if (target.completedAt) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "That thread is already complete.",
        });
      }

      await cancelThread({ threadId: target.id });
      await reapThread({ threadId: target.id });

      try {
        await assertReaped({ threadId: target.id });
      } catch (cause) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "Could not reach that machine to delete the worktree, so the thread was left as it was.",
          cause,
        });
      }

      await completeThread({ threadId: target.id, memberId: ctx.member.id });

      return threadSummary({ projectId: project.id, threadId: target.id });
    }),

  retry: memberProcedure
    .input(
      z.object({
        projectId: z.string().uuid(),
        threadId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const project = await requireOrgProject({
        organizationId: ctx.organizationId,
        memberId: ctx.member.id,
        role: ctx.member.role,
        projectId: input.projectId,
      });
      if (!project) throw new TRPCError({ code: "NOT_FOUND" });

      const target = await threadTarget(input.threadId);
      if (!target || target.projectId !== project.id) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      const retrying = await retryThread({ threadId: target.id });
      if (!retrying) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "That session has no worktree left to retry.",
        });
      }

      return threadSummary({ projectId: project.id, threadId: target.id });
    }),
});
