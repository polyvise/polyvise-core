import { getDebate } from "@polyvise/debate-engine/debate/store";

type RouteContext = {
  params: Promise<{ id: string }> | { id: string };
};

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const debate = getDebate(id);

  if (!debate) {
    return Response.json(
      {
        error: "Debate not found."
      },
      {
        status: 404
      }
    );
  }

  const events = debate.latestRun?.events ?? [];

  if (request.headers.get("accept")?.includes("text/event-stream")) {
    const body = [
      ...events.map((event) => `event: ${event.status}\ndata: ${JSON.stringify(event)}\n\n`),
      "event: done\ndata: {}\n\n"
    ].join("");

    return new Response(body, {
      headers: {
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream"
      }
    });
  }

  return Response.json(
    {
      events
    },
    {
      headers: {
        "Cache-Control": "no-store"
      }
    }
  );
}
