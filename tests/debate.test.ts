import { describe, expect, it } from "vitest";
import { runHybridCouncilDebate } from "@polyvise/debate-engine/debate/engine";
import { debateRequestSchema } from "@polyvise/debate-engine/debate/schema";
import { classifyTopic, detectHighStakes, frameResolution } from "@polyvise/debate-engine/debate/topic";
import { loadDebateRuntimeConfig } from "@polyvise/debate-engine/debate/config";
import { createDefaultLlmProvider, MockLlmProvider, OpenRouterLlmProvider } from "@polyvise/debate-engine/providers/llm";
import { normalizeSources } from "@polyvise/debate-engine/providers/search";
import type { EvidenceSource } from "@polyvise/debate-engine/debate/types";

describe("topic framing", () => {
  it("classifies personal and organizational decisions", () => {
    expect(classifyTopic("Should my company adopt AI customer support this year?")).toBe("decision");
  });

  it("frames direct should questions as neutral resolutions", () => {
    expect(frameResolution("Should schools allow phones during the day?", "policy")).toBe(
      "Resolved: Should schools allow phones during the day."
    );
  });

  it("flags high-stakes topics", () => {
    expect(detectHighStakes("Should I change my medication dose?")?.category).toBe("medical");
    expect(detectHighStakes("Should I invest my retirement portfolio in a single stock?")?.category).toBe("financial");
  });
});

describe("source normalization", () => {
  it("deduplicates sources by URL and trims fields", () => {
    const sources: EvidenceSource[] = [
      {
        id: "a",
        title: " Source A ",
        url: "https://example.com/report/",
        publisher: " Example ",
        snippet: " Snippet ",
        quality: "expert",
        retrievedVia: "mock",
        status: "accepted"
      },
      {
        id: "b",
        title: "Source A Duplicate",
        url: "https://example.com/report",
        publisher: "Example",
        snippet: "Duplicate",
        quality: "expert",
        retrievedVia: "mock",
        status: "accepted"
      }
    ];

    expect(normalizeSources(sources)).toHaveLength(1);
    expect(normalizeSources(sources)[0].title).toBe("Source A");
  });
});

describe("request schema", () => {
  it("rejects underspecified subjects", () => {
    expect(debateRequestSchema.safeParse({ subject: "AI" }).success).toBe(false);
  });

  it("defaults to the v1 debate settings", () => {
    const parsed = debateRequestSchema.parse({ subject: "Should cities ban private cars downtown?" });
    expect(parsed.mode).toBe("hybrid_council");
    expect(parsed.evidence).toBe("cited");
  });
});

describe("LLM provider selection", () => {
  it("keeps deterministic mock mode as the default", () => {
    const config = loadDebateRuntimeConfig({});

    expect(config.enableMockLlm).toBe(true);
    expect(createDefaultLlmProvider(config)).toBeInstanceOf(MockLlmProvider);
  });

  it("uses OpenRouter when mock mode is explicitly disabled", () => {
    const config = loadDebateRuntimeConfig({
      POLYVISE_ENABLE_MOCK_LLM: "false",
      POLYVISE_QUICK_MODEL: "openai/gpt-4o-mini"
    });

    expect(config.enableMockLlm).toBe(false);
    expect(createDefaultLlmProvider(config)).toBeInstanceOf(OpenRouterLlmProvider);
  });
});

describe("hybrid council engine", () => {
  it("produces a complete cited debate run", async () => {
    const run = await runHybridCouncilDebate("debate_test", {
      subject: "Should a small company adopt AI customer support this year?"
    });

    expect(run.status).toBe("complete");
    expect(run.scouts).toHaveLength(5);
    expect(run.teams.pro).toHaveLength(2);
    expect(run.teams.con).toHaveLength(2);
    expect(run.sources.length).toBeGreaterThanOrEqual(2);
    expect(run.claims.filter((claim) => claim.side === "pro")).toHaveLength(3);
    expect(run.claims.filter((claim) => claim.side === "con")).toHaveLength(3);
    expect(run.turns.map((turn) => turn.round)).toContain("cross_examination");
    expect(run.summary.whatWouldChangeMind.length).toBeGreaterThan(0);
    expect(run.trace.map((entry) => entry.step)).toEqual([
      "frame",
      "scout",
      "team_builder",
      "evidence",
      "opening",
      "opening",
      "cross_exam",
      "rebuttal",
      "judge_review",
      "rebuttal",
      "judge",
      "persist"
    ]);
    expect(run.modelSnapshots.some((snapshot) => snapshot.id === "mock-claim-builder")).toBe(true);
    expect(run.artifactManifest.map((artifact) => artifact.kind)).toContain("claims");
  });
});
