import { getDebate, subscribeToDebate } from "@polyvise/debate-engine/debate/store";
import type { DebateLiveEvent } from "@polyvise/debate-engine/debate/types";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string }> | { id: string };
};

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const debate = getDebate(id);

  if (!debate) {
    return Response.json({ error: "Debate not found." }, { status: 404 });
  }

  const encoder = new TextEncoder();
  let teardown: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const closeStream = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          closeStream();
        }
      };

      const writeEvent = (event: DebateLiveEvent) => {
        safeEnqueue(encoder.encode(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`));
        if (event.kind === "complete" || event.kind === "error") {
          setTimeout(closeStream, 50);
        }
      };

      const { unsubscribe, terminal } = subscribeToDebate(id, writeEvent);

      if (terminal) {
        safeEnqueue(encoder.encode(`event: closed\ndata: {}\n\n`));
        closeStream();
        return;
      }

      const heartbeat = setInterval(() => {
        safeEnqueue(encoder.encode(`: ping\n\n`));
      }, 15000);

      teardown = () => {
        clearInterval(heartbeat);
        unsubscribe();
        closeStream();
      };
    },
    cancel() {
      teardown?.();
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}
