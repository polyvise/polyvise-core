import { NextRequest } from "next/server";
import { ZodError } from "zod";
import { submitFeedback } from "@polyvise/debate-engine/debate/store";

export async function POST(request: NextRequest) {
  try {
    const payload = await request.json();
    const feedback = await submitFeedback({
      app: "debatefrog",
      message: payload.message,
      debateId: payload.debateId,
      pagePath: payload.pagePath,
      userAgent: request.headers.get("user-agent") ?? undefined,
      metadata: {
        referrer: request.headers.get("referer") ?? undefined
      }
    });

    return Response.json(
      { ok: true, id: feedback.id },
      {
        status: 201,
        headers: {
          "Cache-Control": "no-store"
        }
      }
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: "Feedback needs a little more shape." }, { status: 400 });
    }

    return Response.json({ error: "Unable to save feedback right now." }, { status: 500 });
  }
}
