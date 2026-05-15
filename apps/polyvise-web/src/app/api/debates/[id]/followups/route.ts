import { ZodError } from "zod";
import { followupRequestSchema } from "@polyvise/debate-engine/debate/schema";
import { addFollowup } from "@polyvise/debate-engine/debate/store";

type RouteContext = {
  params: Promise<{ id: string }> | { id: string };
};

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;

  try {
    const payload = followupRequestSchema.parse(await request.json());
    const followup = await addFollowup(id, payload.question);

    if (!followup) {
      return Response.json(
        {
          error: "Debate not found or not complete."
        },
        {
          status: 404
        }
      );
    }

    return Response.json(
      {
        followup
      },
      {
        status: 201,
        headers: {
          "Cache-Control": "no-store"
        }
      }
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json(
        {
          error: "Invalid follow-up request.",
          issues: error.issues
        },
        {
          status: 400
        }
      );
    }

    return Response.json(
      {
        error: error instanceof Error ? error.message : "Unable to answer follow-up."
      },
      {
        status: 500
      }
    );
  }
}
