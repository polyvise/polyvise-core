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

  it("frames comparative is questions as direct comparison resolutions", () => {
    const subject = "Is Carl Jung's work more influential than Sigmund Freud's?";

    expect(classifyTopic(subject)).toBe("comparison");
    expect(frameResolution(subject, "comparison")).toBe(
      "Resolved: Carl Jung's work is more influential than Sigmund Freud's."
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

  it("collapses to a single pro and single con agent when councilSize is duo", async () => {
    const run = await runHybridCouncilDebate("debate_duo_test", {
      subject: "Should schools have longer recess for kids?",
      councilSize: "duo"
    });

    expect(run.status).toBe("complete");
    // Duo mode: exactly one debater per side plus the neutral judge.
    expect(run.teams.pro).toHaveLength(1);
    expect(run.teams.con).toHaveLength(1);

    // Every debate round (opening, cross-examination, rebuttal, closing)
    // must still feature both a pro and a con voice — otherwise we'd lose
    // the "this is how a debate works" teaching value of duo mode. With
    // only one agent per side, that single agent should be the speaker
    // in every round on its side.
    const proAgentId = run.teams.pro[0].id;
    const conAgentId = run.teams.con[0].id;
    const debateRounds: Array<"opening" | "cross_examination" | "rebuttal" | "closing"> = [
      "opening",
      "cross_examination",
      "rebuttal",
      "closing"
    ];
    for (const round of debateRounds) {
      const turnsForRound = run.turns.filter((turn) => turn.round === round);
      const proTurn = turnsForRound.find((turn) => turn.side === "pro");
      const conTurn = turnsForRound.find((turn) => turn.side === "con");
      expect(proTurn, `pro turn missing for ${round}`).toBeDefined();
      expect(conTurn, `con turn missing for ${round}`).toBeDefined();
      expect(proTurn?.agentId).toBe(proAgentId);
      expect(conTurn?.agentId).toBe(conAgentId);
    }
  });

  it("defaults to the quartet shape when councilSize is omitted", async () => {
    const run = await runHybridCouncilDebate("debate_default_test", {
      subject: "Should remote work be the default for software teams?"
    });
    expect(run.teams.pro).toHaveLength(2);
    expect(run.teams.con).toHaveLength(2);
  });
});
