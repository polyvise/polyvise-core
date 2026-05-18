import type { ModelSnapshot } from "../debate/types";
import { loadDebateRuntimeConfig, modelRosterFromConfig, type DebateRuntimeConfig } from "../debate/config";

export interface LlmRequest {
  role: string;
  prompt: string;
  schemaName: string;
  jsonSchema?: Record<string, unknown>;
  fallback?: unknown;
}

export interface LlmProvider {
  name: string;
  configured: boolean;
  generateStructured<T>(request: LlmRequest): Promise<{
    data: T;
    snapshot: ModelSnapshot;
  }>;
  /** Returns the model id that would be used for a given role, before any call is made. */
  modelForRole(role: string): string;
}

export const modelRoster: ModelSnapshot[] = modelRosterFromConfig(loadDebateRuntimeConfig());

export function createDefaultLlmProvider(config = loadDebateRuntimeConfig()): LlmProvider {
  if (config.enableMockLlm) {
    return new MockLlmProvider();
  }

  return new OpenRouterLlmProvider(config);
}

export class MockLlmProvider implements LlmProvider {
  name = "mock";
  configured = true;

  async generateStructured<T>(request: LlmRequest): Promise<{ data: T; snapshot: ModelSnapshot }> {
    return {
      data: (request.fallback ?? JSON.parse(request.prompt)) as T,
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

  modelForRole(_role: string): string {
    return "deterministic-template";
  }
}

type OpenRouterChatCompletion = {
  choices?: Array<{
    message?: {
      content?: string | null;
      refusal?: string | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
  };
};

export class OpenRouterLlmProvider implements LlmProvider {
  name = "openrouter";
  configured = Boolean(process.env.OPENROUTER_API_KEY);

  constructor(
    private readonly config = loadDebateRuntimeConfig(),
    private readonly apiKey = process.env.OPENROUTER_API_KEY
  ) {}

  async generateStructured<T>(request: LlmRequest): Promise<{ data: T; snapshot: ModelSnapshot }> {
    const model = this.modelForRole(request.role);
    const started = Date.now();

    if (!this.apiKey) {
      throw new Error("OPENROUTER_API_KEY is required when POLYVISE_ENABLE_MOCK_LLM=false.");
    }

    try {
      return await this.completeStructured<T>(request, model, started, Boolean(request.jsonSchema));
    } catch (error) {
      if (!request.jsonSchema) {
        throw error;
      }

      return this.completeStructured<T>(request, model, started, false);
    }
  }

  private async completeStructured<T>(
    request: LlmRequest,
    model: string,
    started: number,
    useJsonSchema: boolean
  ): Promise<{ data: T; snapshot: ModelSnapshot }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.llmTimeoutMs);

    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
          "X-Title": "Polyvise"
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "system",
              content:
                "You are one step in a structured multi-agent debate workflow. Return only valid JSON matching the requested schema. Do not include markdown."
            },
            {
              role: "user",
              content: `Role: ${request.role}\nSchema: ${request.schemaName}\nDraft context JSON:\n${request.prompt}`
            }
          ],
          max_tokens: this.config.llmMaxTokens,
          temperature: 0.3,
          response_format: useJsonSchema && request.jsonSchema
            ? {
                type: "json_schema",
                json_schema: {
                  name: request.schemaName,
                  strict: true,
                  schema: request.jsonSchema
                }
              }
            : {
                type: "json_object"
              }
        }),
        signal: controller.signal
      });

      const payload = (await response.json().catch(() => ({}))) as OpenRouterChatCompletion & {
        error?: { message?: string };
      };

      if (!response.ok) {
        throw new Error(payload.error?.message ?? `OpenRouter request failed with ${response.status}.`);
      }

      const content = payload.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error(payload.choices?.[0]?.message?.refusal ?? "OpenRouter returned an empty response.");
      }

      return {
        data: JSON.parse(content) as T,
        snapshot: {
          id: `openrouter-${request.role.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
          provider: "openrouter",
          model,
          role: request.role,
          configured: true,
          latencyMs: Date.now() - started,
          promptTokens: payload.usage?.prompt_tokens,
          completionTokens: payload.usage?.completion_tokens,
          estimatedCostUsd: payload.usage?.cost
        }
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  modelForRole(role: string): string {
    const normalized = role.toLowerCase();
    if (normalized.includes("judge") || normalized.includes("summary") || normalized.includes("scorecard")) {
      return this.config.judgeModel;
    }
    if (normalized.includes("claim") || normalized.includes("rebuttal")) {
      return this.config.deepModel;
    }
    return this.config.quickModel;
  }
}
