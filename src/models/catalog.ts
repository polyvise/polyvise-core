export type ModelProvider =
  | "anthropic"
  | "deepseek"
  | "google"
  | "moonshot"
  | "openai"
  | "xai"
  | "zai";

export type ModelSpeed = "fast" | "balanced" | "deliberate";
export type ModelTier = "economy" | "standard" | "premium";
export type ModelCompatibility = "supported" | "experimental";

export interface AvailableModel {
  id: string;
  label: string;
  provider: ModelProvider;
  speed: ModelSpeed;
  tier: ModelTier;
  reasoning: boolean;
  compatibility: ModelCompatibility;
  compatibilityNote?: string;
  notes?: string;
}

const KNOWN_MODELS = [
  {
    id: "openai/gpt-5.5",
    label: "GPT-5.5",
    provider: "openai",
    speed: "balanced",
    tier: "premium",
    reasoning: true,
    compatibility: "supported"
  },
  {
    id: "openai/gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    provider: "openai",
    speed: "deliberate",
    tier: "premium",
    reasoning: true,
    compatibility: "supported",
    notes: "Deep reasoning"
  },
  {
    id: "openai/gpt-4.1",
    label: "GPT-4.1",
    provider: "openai",
    speed: "balanced",
    tier: "standard",
    reasoning: true,
    compatibility: "supported"
  },
  {
    id: "openai/gpt-4o-mini",
    label: "GPT-4o mini",
    provider: "openai",
    speed: "fast",
    tier: "economy",
    reasoning: false,
    compatibility: "supported",
    notes: "Fast, economical"
  },
  {
    id: "anthropic/claude-sonnet-5",
    label: "Claude Sonnet 5",
    provider: "anthropic",
    speed: "balanced",
    tier: "premium",
    reasoning: true,
    compatibility: "experimental",
    compatibilityNote:
      "Returned empty content for Polyvise's production-sized scout contract on July 24, 2026."
  },
  {
    id: "anthropic/claude-opus-4.8",
    label: "Claude Opus 4.8",
    provider: "anthropic",
    speed: "deliberate",
    tier: "premium",
    reasoning: true,
    compatibility: "supported",
    notes: "Deep reasoning"
  },
  {
    id: "anthropic/claude-sonnet-4.6",
    label: "Claude Sonnet 4.6",
    provider: "anthropic",
    speed: "balanced",
    tier: "standard",
    reasoning: true,
    compatibility: "supported"
  },
  {
    id: "google/gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    provider: "google",
    speed: "fast",
    tier: "standard",
    reasoning: true,
    compatibility: "experimental",
    compatibilityNote:
      "Requires strict JSON Schema mode for Polyvise's production-sized scout contract.",
    notes: "Fast"
  },
  {
    id: "google/gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash Lite",
    provider: "google",
    speed: "fast",
    tier: "economy",
    reasoning: false,
    compatibility: "supported",
    notes: "Fast, economical"
  },
  {
    id: "google/gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    provider: "google",
    speed: "fast",
    tier: "economy",
    reasoning: true,
    compatibility: "supported",
    notes: "Fast, economical"
  },
  {
    id: "deepseek/deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    provider: "deepseek",
    speed: "deliberate",
    tier: "standard",
    reasoning: true,
    compatibility: "supported"
  },
  {
    id: "deepseek/deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    provider: "deepseek",
    speed: "fast",
    tier: "economy",
    reasoning: true,
    compatibility: "supported",
    notes: "Fast"
  },
  {
    id: "x-ai/grok-4.5",
    label: "Grok 4.5",
    provider: "xai",
    speed: "balanced",
    tier: "premium",
    reasoning: true,
    compatibility: "supported"
  },
  {
    id: "z-ai/glm-5.2",
    label: "GLM 5.2",
    provider: "zai",
    speed: "balanced",
    tier: "standard",
    reasoning: true,
    compatibility: "supported"
  },
  {
    id: "moonshotai/kimi-k3",
    label: "Kimi K3",
    provider: "moonshot",
    speed: "balanced",
    tier: "standard",
    reasoning: true,
    compatibility: "experimental",
    compatibilityNote:
      "Returned empty content for both production-sized scout and claim contracts on July 24, 2026."
  }
] as const satisfies readonly AvailableModel[];

/**
 * Returns the versioned catalog of OpenRouter models supported by Polyvise.
 *
 * This is intentionally a curated list rather than a live OpenRouter request,
 * so applications have stable choices and metadata. Callers receive copies and
 * cannot mutate the shared catalog.
 */
export function getAvailableModels(): AvailableModel[] {
  return KNOWN_MODELS
    .filter((model) => model.compatibility === "supported")
    .map((model) => ({ ...model }));
}

export function getAvailableModel(id: string): AvailableModel | undefined {
  const model = KNOWN_MODELS.find(
    (candidate) => candidate.id === id && candidate.compatibility === "supported"
  );
  return model ? { ...model } : undefined;
}

export function getKnownModels(): AvailableModel[] {
  return KNOWN_MODELS.map((model) => ({ ...model }));
}

export function getKnownModel(id: string): AvailableModel | undefined {
  const model = KNOWN_MODELS.find((candidate) => candidate.id === id);
  return model ? { ...model } : undefined;
}
