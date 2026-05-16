export type SlotId = "quick" | "deep" | "judge";

export interface ModelOption {
  id: string;
  label: string;
  provider: "anthropic" | "openai" | "google" | "meta" | "deepseek" | "mistral" | "xai";
  notes?: string;
}

export interface SlotMeta {
  id: SlotId;
  title: string;
  description: string;
  envVar: string;
}

export const slots: SlotMeta[] = [
  {
    id: "quick",
    title: "Pro agents & scouts",
    description: "Fast turns: stance scouts and opening pro statements.",
    envVar: "POLYVISE_QUICK_MODEL"
  },
  {
    id: "deep",
    title: "Con agents & claims",
    description: "Heavier reasoning: claim building and rebuttals.",
    envVar: "POLYVISE_DEEP_MODEL"
  },
  {
    id: "judge",
    title: "Judge",
    description: "Neutral synthesis: scorecard and final summary.",
    envVar: "POLYVISE_JUDGE_MODEL"
  }
];

export const modelCatalog: ModelOption[] = [
  { id: "anthropic/claude-3.5-sonnet", label: "Claude 3.5 Sonnet", provider: "anthropic" },
  { id: "anthropic/claude-3.5-haiku", label: "Claude 3.5 Haiku", provider: "anthropic", notes: "Fast, cheap" },
  { id: "anthropic/claude-3-opus", label: "Claude 3 Opus", provider: "anthropic" },
  { id: "openai/gpt-4.1", label: "GPT-4.1", provider: "openai" },
  { id: "openai/gpt-4o", label: "GPT-4o", provider: "openai" },
  { id: "openai/gpt-4o-mini", label: "GPT-4o mini", provider: "openai", notes: "Fast, cheap" },
  { id: "openai/o3-mini", label: "o3-mini", provider: "openai", notes: "Reasoning" },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", provider: "google" },
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", provider: "google", notes: "Fast, cheap" },
  { id: "deepseek/deepseek-r1", label: "DeepSeek R1", provider: "deepseek", notes: "Reasoning" },
  { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B", provider: "meta" },
  { id: "mistralai/mistral-large", label: "Mistral Large", provider: "mistral" },
  { id: "x-ai/grok-2-1212", label: "Grok 2", provider: "xai" }
];

export const defaultSelections: Record<SlotId, string> = {
  quick: "openai/gpt-4.1",
  deep: "openai/gpt-4o",
  judge: "google/gemini-2.5-flash"
};

export function isKnownModel(id: string): boolean {
  return modelCatalog.some((entry) => entry.id === id);
}
