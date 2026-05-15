import type { ModelSnapshot } from "./types";

export type EvidenceProviderName = "brave" | "mock";

export interface DebateRuntimeConfig {
  quickModel: string;
  deepModel: string;
  judgeModel: string;
  maxRounds: number;
  llmTimeoutMs: number;
  llmMaxTokens: number;
  evidenceProvider: EvidenceProviderName;
  enableMockLlm: boolean;
}

export function loadDebateRuntimeConfig(env: NodeJS.ProcessEnv = process.env): DebateRuntimeConfig {
  return {
    quickModel: env.POLYVISE_QUICK_MODEL || "gpt-4.1",
    deepModel: env.POLYVISE_DEEP_MODEL || "claude-3.7-sonnet",
    judgeModel: env.POLYVISE_JUDGE_MODEL || "gemini-2.5-pro",
    maxRounds: coercePositiveInteger(env.POLYVISE_MAX_ROUNDS, 3),
    llmTimeoutMs: coercePositiveInteger(env.POLYVISE_LLM_TIMEOUT_MS, 45000),
    llmMaxTokens: coercePositiveInteger(env.POLYVISE_LLM_MAX_TOKENS, 1800),
    evidenceProvider: env.POLYVISE_EVIDENCE_PROVIDER === "mock" ? "mock" : "brave",
    enableMockLlm: env.POLYVISE_ENABLE_MOCK_LLM !== "false"
  };
}

export function modelRosterFromConfig(config: DebateRuntimeConfig): ModelSnapshot[] {
  return [
    {
      id: "polyvise-quick",
      provider: inferProvider(config.quickModel),
      model: config.quickModel,
      role: "stance scout and fast debate turns",
      configured: isConfigured(config.quickModel)
    },
    {
      id: "polyvise-deep",
      provider: inferProvider(config.deepModel),
      model: config.deepModel,
      role: "claims, rebuttals, and evidence reasoning",
      configured: isConfigured(config.deepModel)
    },
    {
      id: "polyvise-judge",
      provider: inferProvider(config.judgeModel),
      model: config.judgeModel,
      role: "scorecard and final synthesis judge",
      configured: isConfigured(config.judgeModel)
    }
  ];
}

function coercePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function inferProvider(model: string): ModelSnapshot["provider"] {
  const normalized = model.toLowerCase();
  if (normalized.includes("claude")) {
    return "anthropic";
  }
  if (normalized.includes("gemini")) {
    return "google";
  }
  if (normalized.includes("/") || normalized.includes("openrouter")) {
    return "openrouter";
  }
  return "openai";
}

function isConfigured(model: string): boolean {
  const provider = inferProvider(model);

  if (provider === "anthropic") {
    return Boolean(process.env.ANTHROPIC_API_KEY);
  }
  if (provider === "google") {
    return Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY);
  }
  if (provider === "openrouter") {
    return Boolean(process.env.OPENROUTER_API_KEY);
  }
  return Boolean(process.env.OPENAI_API_KEY);
}
