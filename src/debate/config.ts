import type { ModelSnapshot } from "./types";
import { getAvailableModels, getKnownModel } from "../models/catalog";

export type EvidenceProviderName = "brave" | "mock" | "tavily";

export interface DebateRuntimeConfig {
  quickModel: string;
  deepModel: string;
  yesModel: string;
  noModel: string;
  judgeModel: string;
  maxRounds: number;
  llmTimeoutMs: number;
  llmMaxTokens: number;
  llmMaxAttempts: number;
  apiRetryBaseDelayMs: number;
  evidenceProvider: EvidenceProviderName;
  enableMockLlm: boolean;
  allowDeterministicFallbacks: boolean;
  useStrictJsonSchema: boolean;
  modelOptions: string[];
}

export function loadDebateRuntimeConfig(env: NodeJS.ProcessEnv = process.env): DebateRuntimeConfig {
  const isProduction = env.NODE_ENV === "production";

  return {
    quickModel: env.POLYVISE_QUICK_MODEL || "google/gemini-2.5-flash",
    deepModel: env.POLYVISE_DEEP_MODEL || "google/gemini-2.5-flash",
    yesModel: env.POLYVISE_YES_MODEL || "google/gemini-2.5-flash",
    noModel: env.POLYVISE_NO_MODEL || "google/gemini-2.5-flash",
    judgeModel: env.POLYVISE_JUDGE_MODEL || "openai/gpt-4.1",
    maxRounds: coercePositiveInteger(env.POLYVISE_MAX_ROUNDS, 3),
    llmTimeoutMs: coercePositiveInteger(env.POLYVISE_LLM_TIMEOUT_MS, 45000),
    llmMaxTokens: coercePositiveInteger(env.POLYVISE_LLM_MAX_TOKENS, 1800),
    llmMaxAttempts: coercePositiveInteger(env.POLYVISE_LLM_MAX_ATTEMPTS, 3),
    apiRetryBaseDelayMs: coercePositiveInteger(env.POLYVISE_API_RETRY_BASE_DELAY_MS, 600),
    evidenceProvider: coerceEvidenceProvider(env.POLYVISE_EVIDENCE_PROVIDER),
    enableMockLlm: !isProduction && coerceBoolean(env.POLYVISE_ENABLE_MOCK_LLM, true),
    allowDeterministicFallbacks:
      !isProduction && coerceBoolean(env.POLYVISE_ALLOW_DETERMINISTIC_FALLBACKS, true),
    useStrictJsonSchema: coerceBoolean(env.POLYVISE_USE_STRICT_JSON_SCHEMA, false),
    modelOptions: coerceModelOptions(env.POLYVISE_OPENROUTER_MODEL_OPTIONS, [
      env.POLYVISE_YES_MODEL || "google/gemini-2.5-flash",
      env.POLYVISE_NO_MODEL || "google/gemini-2.5-flash",
      env.POLYVISE_JUDGE_MODEL || "openai/gpt-4.1",
      ...getAvailableModels().map((model) => model.id)
    ])
  };
}

function coerceEvidenceProvider(value: string | undefined): EvidenceProviderName {
  if (value === "mock" || value === "tavily") {
    return value;
  }
  return "brave";
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
      id: "polyvise-yes",
      provider: inferProvider(config.yesModel),
      model: config.yesModel,
      role: "pro-side claims and turns",
      configured: isConfigured(config.yesModel)
    },
    {
      id: "polyvise-no",
      provider: inferProvider(config.noModel),
      model: config.noModel,
      role: "con-side claims and turns",
      configured: isConfigured(config.noModel)
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

function coerceBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return value === "true" || value === "1" || value === "yes";
}

function coerceModelOptions(value: string | undefined, defaults: string[]): string[] {
  const raw = value
    ? value.split(",").map((item) => item.trim()).filter(Boolean)
    : defaults;

  return Array.from(new Set(raw));
}

export function modelOptionsFromConfig(config: DebateRuntimeConfig): {
  defaults: { yes: string; no: string; judge: string };
  options: Array<{ id: string; label: string }>;
} {
  const options = Array.from(
    new Set([config.yesModel, config.noModel, config.judgeModel, ...config.modelOptions])
  );

  return {
    defaults: {
      yes: config.yesModel,
      no: config.noModel,
      judge: config.judgeModel
    },
    options: options.map((id) => ({
      id,
      label: labelForModel(id)
    }))
  };
}

function labelForModel(id: string): string {
  const catalogModel = getKnownModel(id);
  if (catalogModel) {
    return catalogModel.label;
  }

  return id
    .split("/")
    .pop()!
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace(/\bGpt\b/g, "GPT");
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
