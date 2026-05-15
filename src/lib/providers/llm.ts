import type { ModelSnapshot } from "@/lib/debate/types";
import { loadDebateRuntimeConfig, modelRosterFromConfig } from "@/lib/debate/config";

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

export const modelRoster: ModelSnapshot[] = modelRosterFromConfig(loadDebateRuntimeConfig());

export function createDefaultLlmProvider(): LlmProvider {
  return new MockLlmProvider();
}

export class MockLlmProvider implements LlmProvider {
  name = "mock";
  configured = true;

  async generateStructured<T>(request: LlmRequest): Promise<{ data: T; snapshot: ModelSnapshot }> {
    return {
      data: JSON.parse(request.prompt) as T,
      snapshot: {
        id: `mock-${request.role.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
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
