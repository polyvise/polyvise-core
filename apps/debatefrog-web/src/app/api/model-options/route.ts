import { loadDebateRuntimeConfig, modelOptionsFromConfig } from "@polyvise/debate-engine/debate/config";

export async function GET() {
  return Response.json(
    {
      ...modelOptionsFromConfig(loadDebateRuntimeConfig()),
      dev: {
        liveApiToggleAvailable: process.env.NODE_ENV !== "production",
        hasOpenRouterKey: Boolean(process.env.OPENROUTER_API_KEY),
        hasTavilyKey: Boolean(process.env.TAVILY_API_KEY)
      }
    },
    {
      headers: {
        "Cache-Control": "no-store"
      }
    }
  );
}
