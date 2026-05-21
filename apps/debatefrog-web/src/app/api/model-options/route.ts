import { loadDebateRuntimeConfig, modelOptionsFromConfig } from "@polyvise/debate-engine/debate/config";

export async function GET() {
  return Response.json(modelOptionsFromConfig(loadDebateRuntimeConfig()), {
    headers: {
      "Cache-Control": "no-store"
    }
  });
}
