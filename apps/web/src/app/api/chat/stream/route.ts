import { authorizeChatStream } from "@roster/api";

import { getSession } from "~/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KEEPALIVE_MS = 20_000;

export async function GET(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const params = new URL(request.url).searchParams;
  const slug = params.get("slug");
  const projectId = params.get("projectId");
  const threadId = params.get("threadId");
  if (!slug || !projectId || !threadId) {
    return new Response("Missing parameters", { status: 400 });
  }

  const target = await authorizeChatStream({
    userId: session.user.id,
    slug,
    projectId,
    threadId,
    rosterSessionId: params.get("rosterSessionId") ?? undefined,
  });
  if (!target) return new Response("Not found", { status: 404 });

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const socket = new WebSocket(target.url);

      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      const keepalive = setInterval(() => write(": keepalive\n\n"), KEEPALIVE_MS);

      const shutdown = () => {
        if (closed) return;
        clearInterval(keepalive);
        closed = true;
        try {
          socket.close();
        } catch {}
        try {
          controller.close();
        } catch {}
      };

      socket.onopen = () => {
        write(`event: open\ndata: ${JSON.stringify({ chatSessionId: target.chatSessionId })}\n\n`);
      };

      socket.onmessage = (event: MessageEvent) => {
        if (typeof event.data !== "string") return;
        write(`data: ${event.data.replace(/\n/g, "")}\n\n`);
      };

      socket.onerror = () => shutdown();
      socket.onclose = () => shutdown();

      request.signal.addEventListener("abort", shutdown);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
