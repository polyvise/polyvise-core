import type { ModelCallAttempt, ModelSnapshot } from "../debate/types";
import { loadDebateRuntimeConfig, modelRosterFromConfig, type DebateRuntimeConfig } from "../debate/config";

export interface LlmRequest {
  role: string;
  prompt: string;
  schemaName: string;
  jsonSchema?: Record<string, unknown>;
  fallback?: unknown;
  sessionId?: string;
  /**
   * Call this exact model instead of the one the role would route to.
   *
   * Role-based routing is what the debate engine wants — the slot config
   * decides which model argues which side. Callers that need to address one
   * specific model (a side-by-side comparison, an eval harness) set this and
   * bypass routing entirely.
   */
  model?: string;
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

function slug(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

/**
 * Snapshot ids have to stay unique within a run, because `mergeModelSnapshots`
 * dedupes on them. Role alone is enough for the debate engine, where each role
 * is called once — but a caller overriding the model asks the same role
 * repeatedly, so the model has to be part of the id in that case.
 */
function snapshotId(prefix: string, request: LlmRequest): string {
  const base = `${prefix}-${slug(request.role)}`;
  return request.model ? `${base}-${slug(request.model)}` : base;
}

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
        id: snapshotId("mock", request),
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
    const model = request.model?.trim() || this.modelForRole(request.role);
    const started = Date.now();
    const attempts: ModelCallAttempt[] = [];

    if (!this.apiKey) {
      throw new Error("OPENROUTER_API_KEY is required when POLYVISE_ENABLE_MOCK_LLM=false.");
    }

    const useStrictSchema = this.config.useStrictJsonSchema && Boolean(request.jsonSchema);

    try {
      return await this.completeStructuredWithRetry<T>(
        request,
        model,
        started,
        useStrictSchema,
        attempts
      );
    } catch (error) {
      if (!useStrictSchema) {
        throw error;
      }

      return this.completeStructuredWithRetry<T>(request, model, started, false, attempts);
    }
  }

  private async completeStructuredWithRetry<T>(
    request: LlmRequest,
    model: string,
    started: number,
    useJsonSchema: boolean,
    attempts: ModelCallAttempt[]
  ): Promise<{ data: T; snapshot: ModelSnapshot }> {
    let lastError: unknown;
    const mode = useJsonSchema ? "json_schema" : "json_object";

    for (let attempt = 1; attempt <= this.config.llmMaxAttempts; attempt += 1) {
      const attemptStarted = Date.now();
      try {
        const result = await this.completeStructured<T>(request, model, started, useJsonSchema);
        attempts.push({
          attempt,
          mode,
          status: "ok",
          durationMs: Date.now() - attemptStarted
        });
        return {
          ...result,
          snapshot: {
            ...result.snapshot,
            attempts: [...attempts]
          }
        };
      } catch (error) {
        lastError = error;
        const durationMs = Date.now() - attemptStarted;
        attempts.push({
          attempt,
          mode,
          status: "failed",
          durationMs,
          message: error instanceof Error ? sanitizeProviderMessage(error.message) : "AI model request failed."
        });
        logOpenRouterAttemptFailure({
          error,
          model,
          role: request.role,
          mode,
          attempt,
          durationMs
        });
        if (attempt >= this.config.llmMaxAttempts || !isRetriableOpenRouterError(error)) {
          break;
        }
        await delay(this.config.apiRetryBaseDelayMs * attempt);
      }
    }

    const message = lastError instanceof Error ? sanitizeProviderMessage(lastError.message) : "AI model request failed.";
    throw new LlmProviderFailure(message, {
      id: snapshotId("openrouter", request),
      provider: "openrouter",
      model,
      role: request.role,
      configured: true,
      latencyMs: Date.now() - started,
      failure: message,
      attempts: [...attempts]
    });
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
          ...(request.sessionId ? { session_id: sanitizeOpenRouterSessionId(request.sessionId) } : {}),
          messages: [
            {
              role: "system",
              content:
                "You are one step in a structured multi-agent debate workflow. Return exactly one valid JSON object matching the requested schema. Do not include markdown. Use enum values exactly as written."
            },
            {
              role: "user",
              content: [
                `Role: ${request.role}`,
                `Schema name: ${request.schemaName}`,
                request.jsonSchema
                  ? `Required JSON Schema:\n${JSON.stringify(request.jsonSchema, null, 2)}`
                  : "Required JSON Schema: Return the requested JSON object.",
                `Draft context JSON:\n${request.prompt}`
              ].join("\n\n")
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
        throw new OpenRouterRequestError(
          payload.error?.message ?? `OpenRouter request failed with ${response.status}.`,
          response.status
        );
      }

      const content = payload.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error(payload.choices?.[0]?.message?.refusal ?? "AI model returned an empty response.");
      }

      return {
        data: JSON.parse(content) as T,
        snapshot: {
          id: snapshotId("openrouter", request),
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
    if (normalized.includes("yes frog")) {
      return this.config.yesModel;
    }
    if (normalized.includes("no frog")) {
      return this.config.noModel;
    }
    // "chair" joins the judge slot for the same reason judge and summary are
    // there: it is the step that weighs everything else and writes the verdict.
    if (
      normalized.includes("judge") ||
      normalized.includes("summary") ||
      normalized.includes("scorecard") ||
      normalized.includes("chair")
    ) {
      return this.config.judgeModel;
    }
    // Panel advice and consensus positions are the reasoning-heavy steps of
    // their modes, so they route to the deep slot alongside claims.
    if (
      normalized.includes("claim") ||
      normalized.includes("rebuttal") ||
      normalized.includes("consensus agent") ||
      normalized.startsWith("panel ")
    ) {
      return this.config.deepModel;
    }
    return this.config.quickModel;
  }
}

class OpenRouterRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export class LlmProviderFailure extends Error {
  constructor(
    message: string,
    readonly snapshot: ModelSnapshot
  ) {
    super(message);
  }
}

function isRetriableOpenRouterError(error: unknown): boolean {
  if (error instanceof OpenRouterRequestError) {
    return error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500;
  }

  return (
    error instanceof SyntaxError ||
    error instanceof TypeError ||
    (error instanceof Error && (error.name === "AbortError" || error.message.includes("empty response")))
  );
}

function logOpenRouterAttemptFailure({
  error,
  model,
  role,
  mode,
  attempt,
  durationMs
}: {
  error: unknown;
  model: string;
  role: string;
  mode: "json_schema" | "json_object";
  attempt: number;
  durationMs: number;
}) {
  const status = error instanceof OpenRouterRequestError ? error.status : undefined;
  const message = error instanceof Error ? sanitizeProviderMessage(error.message) : "unknown provider error";
  console.warn("[polyvise.llm.attempt_failed]", {
    attempt,
    durationMs,
    mode,
    model,
    role,
    status,
    retriable: isRetriableOpenRouterError(error),
    reason: classifyOpenRouterFailure(error),
    message
  });
}

function classifyOpenRouterFailure(error: unknown): string {
  if (error instanceof OpenRouterRequestError) {
    if (error.status === 408) return "timeout";
    if (error.status === 409) return "upstream conflict";
    if (error.status === 429) return "rate limited";
    if (error.status === 401 || error.status === 403) return "provider authorization or quota error";
    if (error.status >= 500) return "upstream service error";
    return "provider returned error";
  }
  if (error instanceof Error && error.name === "AbortError") return "timeout";
  if (error instanceof SyntaxError) return "invalid JSON";
  if (error instanceof TypeError) return "network error";
  return "unknown provider error";
}

function sanitizeProviderMessage(message: string): string {
  return message
    .replace(/https:\/\/openrouter\.ai\/workspaces\/[^\s"')]+/g, "the provider dashboard")
    .replace(/sk-or-v1-[a-zA-Z0-9_-]+/g, "[redacted-api-key]");
}

function sanitizeOpenRouterSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_.:-]/g, "-").slice(0, 256);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
