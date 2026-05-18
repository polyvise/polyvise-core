import { NextRequest } from "next/server";
import { ZodError } from "zod";
import { startDebate } from "@polyvise/debate-engine/debate/store";

export async function POST(request: NextRequest) {
  try {
    const payload = await request.json();
    const { debate } = await startDebate(payload);

    return Response.json(
      {
        debate
      },
      {
        status: 202,
        headers: {
          "Cache-Control": "no-store"
        }
      }
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json(
        {
          error: "That debate needs a little more shape.",
          issues: error.issues
        },
        {
          status: 400
        }
      );
    }

    return Response.json(
      {
        error: error instanceof Error ? error.message : "Unable to start the debate."
      },
      {
        status: 500
      }
    );
  }
}
