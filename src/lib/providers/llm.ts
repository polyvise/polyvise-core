import type { ModelSnapshot } from "@/lib/debate/types";

export interface LlmRequest {
  role: string;
  prompt: string;
  schemaName: string;
}

export interface LlmProvider {
  name: string;
  configured: boolean;
  generateStructured<T>(request: LlmRequest): Promise<{
    data: T;
    snapshot: ModelSnapshot;
  }>;
}

export const modelRoster: ModelSnapshot[] = [
  {
    id: "openai-strategist",
    provider: "openai",
    model: "gpt-4.1",
    role: "stance scout and synthesis judge",
    configured: Boolean(process.env.OPENAI_API_KEY)
  },
  {
    id: "anthropic-skeptic",
    provider: "anthropic",
    model: "claude-3.7-sonnet",
    role: "risk, objection, and rebuttal agent",
    configured: Boolean(process.env.ANTHROPIC_API_KEY)
  },
  {
    id: "google-empiricist",
    provider: "google",
    model: "gemini-2.5-pro",
    role: "evidence and empirical uncertainty agent",
    configured: Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY)
  },
  {
    id: "openrouter-generalist",
    provider: "openrouter",
    model: "openrouter/auto",
    role: "model diversity and fallback routing",
    configured: Boolean(process.env.OPENROUTER_API_KEY)
  }
];

export class MockLlmProvider implements LlmProvider {
  name = "mock";
  configured = true;

  async generateStructured<T>(request: LlmRequest): Promise<{ data: T; snapshot: ModelSnapshot }> {
    return {
      data: JSON.parse(request.prompt) as T,
      snapshot: {
        id: `mock-${request.role}`,
        provider: "local",
        model: "deterministic-template",
        role: request.role,
        configured: true,
        latencyMs: 0,
        promptTokens: request.prompt.length / 4,
        completionTokens: 0,
        estimatedCostUsd: 0
      }
    };
  }
}
