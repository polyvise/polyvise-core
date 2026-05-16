import { NextRequest } from "next/server";
import { ZodError } from "zod";
import { followupRequestSchema } from "@polyvise/debate-engine/debate/schema";
import { addFollowup } from "@polyvise/debate-engine/debate/store";

type RouteContext = {
  params: Promise<{ id: string }> | { id: string };
};

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { question } = followupRequestSchema.parse(await request.json());
    const exchange = await addFollowup(id, question);

    if (!exchange) {
      return Response.json(
        { error: "That debate is not ready for follow-ups yet." },
        { status: 404 }
      );
    }

    return Response.json({ followup: exchange }, {
      headers: { "Cache-Control": "no-store" }
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json(
        {
          error: "That question needs a bit more shape.",
          issues: error.issues
        },
        { status: 400 }
      );
    }

    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to answer that follow-up." },
      { status: 500 }
    );
  }
}
