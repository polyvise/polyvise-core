import { NextRequest } from "next/server";
import { ZodError } from "zod";
import { createDebate, listDebates } from "@polyvise/debate-engine/debate/store";

export async function GET() {
  return Response.json(
    {
      debates: listDebates()
    },
    {
      headers: {
        "Cache-Control": "no-store"
      }
    }
  );
}

export async function POST(request: NextRequest) {
  try {
    const payload = await request.json();
    const debate = await createDebate(payload);

    return Response.json(
      {
        debate
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
          error: "Invalid debate request.",
          issues: error.issues
        },
        {
          status: 400
        }
      );
    }

    return Response.json(
      {
        error: error instanceof Error ? error.message : "Unable to create debate."
      },
      {
        status: 500
      }
    );
  }
}
