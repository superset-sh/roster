import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  answerThreadApproval,
  listThreadChats,
  stopThreadBackgroundTask,
  threadChatItems,
} from "../services/chat";
import { createTRPCRouter, memberProcedure } from "../trpc";

const threadInput = z.object({
  projectId: z.string().uuid(),
  threadId: z.string().uuid(),
  rosterSessionId: z.string().uuid().optional(),
});

export const chatRouter = createTRPCRouter({
  sessions: memberProcedure.input(threadInput).query(({ ctx, input }) =>
    listThreadChats({
      organizationId: ctx.organizationId,
      memberId: ctx.member.id,
      role: ctx.member.role,
      ...input,
    }),
  ),

  items: memberProcedure
    .input(
      threadInput.extend({
        before: z
          .object({ epoch: z.string().min(1), seq: z.number().int().nonnegative() })
          .optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const page = await threadChatItems({
        organizationId: ctx.organizationId,
        memberId: ctx.member.id,
        role: ctx.member.role,
        ...input,
      });
      if (!page) throw new TRPCError({ code: "NOT_FOUND" });
      return page;
    }),

  answer: memberProcedure
    .input(
      threadInput.extend({
        approvalId: z.string().min(1),
        optionId: z.string().min(1).optional(),
        allow: z.boolean(),
      }),
    )
    .mutation(({ ctx, input }) =>
      answerThreadApproval({
        organizationId: ctx.organizationId,
        memberId: ctx.member.id,
        role: ctx.member.role,
        ...input,
      }),
    ),

  stopTask: memberProcedure
    .input(
      threadInput.extend({
        rosterSessionId: z.string().uuid(),
        taskId: z.string().min(1),
      }),
    )
    .mutation(({ ctx, input }) =>
      stopThreadBackgroundTask({
        organizationId: ctx.organizationId,
        memberId: ctx.member.id,
        role: ctx.member.role,
        ...input,
      }),
    ),
});
