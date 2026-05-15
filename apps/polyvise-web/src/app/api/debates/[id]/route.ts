import { getDebate } from "@polyvise/debate-engine/debate/store";

type RouteContext = {
  params: Promise<{ id: string }> | { id: string };
};

export async function GET(_request: Request, context: RouteContext) {
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

  return Response.json(
    {
      debate
    },
    {
      headers: {
        "Cache-Control": "no-store"
      }
    }
  );
}
