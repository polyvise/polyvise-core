import { afterEach, describe, expect, it, vi } from "vitest";
import { runHybridCouncilDebate } from "@polyvise/debate-engine/debate/engine";
import { debateRequestSchema, feedbackRequestSchema } from "@polyvise/debate-engine/debate/schema";
import { classifyTopic, detectHighStakes, frameResolution } from "@polyvise/debate-engine/debate/topic";
import { loadDebateRuntimeConfig, modelOptionsFromConfig } from "@polyvise/debate-engine/debate/config";
import { listFeedback, submitFeedback } from "@polyvise/debate-engine/debate/store";
import {
  createDefaultLlmProvider,
  MockLlmProvider,
  OpenRouterLlmProvider,
  type LlmRequest
} from "@polyvise/debate-engine/providers/llm";
import { normalizeSources } from "@polyvise/debate-engine/providers/search";
import type { EvidenceSource, ModelSnapshot } from "@polyvise/debate-engine/debate/types";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("topic framing", () => {
  it("classifies personal and organizational decisions", () => {
    expect(classifyTopic("Should my company adopt AI customer support this year?")).toBe("decision");
  });

  it("frames direct should questions as neutral resolutions", () => {
    expect(frameResolution("Should schools allow phones during the day?", "policy")).toBe(
      "Should schools allow phones during the day?"
    );
  });

  it("strips formal resolved prefixes from user-supplied questions", () => {
    expect(frameResolution("Resolved: Should homework be banned?", "policy")).toBe("Should homework be banned?");
  });

  it("frames comparative is questions as direct comparison resolutions", () => {
    const subject = "Is Carl Jung's work more influential than Sigmund Freud's?";

    expect(classifyTopic(subject)).toBe("comparison");
    expect(frameResolution(subject, "comparison")).toBe(
      "Carl Jung's work is more influential than Sigmund Freud's."
    );
  });

  it("keeps direct evidence questions out of decision framing", () => {
    const subject = "Is Trump a corrupt president?";

    expect(classifyTopic(subject)).toBe("empirical");
    expect(frameResolution(subject, "empirical")).toBe("Is Trump a corrupt president?");
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

  it("accepts role-specific model selections", () => {
    const parsed = debateRequestSchema.parse({
      subject: "Should schools have longer recess?",
      models: {
        yes: "openai/gpt-4o-mini",
        no: "anthropic/claude-3.5-haiku",
        judge: "google/gemini-flash-1.5"
      }
    });

    expect(parsed.models?.yes).toBe("openai/gpt-4o-mini");
    expect(parsed.models?.no).toBe("anthropic/claude-3.5-haiku");
  });

  it("accepts development-only live API preferences", () => {
    const parsed = debateRequestSchema.parse({
      subject: "Should schools have longer recess?",
      devOptions: {
        liveApis: true
      }
    });

    expect(parsed.devOptions?.liveApis).toBe(true);
  });
});

describe("feedback", () => {
  it("validates anonymous feedback text", () => {
    expect(feedbackRequestSchema.safeParse({ message: "" }).success).toBe(false);
    expect(feedbackRequestSchema.safeParse({ message: "x".repeat(2001) }).success).toBe(false);
    expect(feedbackRequestSchema.safeParse({ message: "The frogs were charming." }).success).toBe(true);
  });

  it("saves anonymous feedback in the memory repository", async () => {
    const feedback = await submitFeedback({
      message: "The judge should explain close calls more clearly.",
      debateId: "debate_feedback_test",
      pagePath: "/",
      userAgent: "vitest"
    });
    const allFeedback = await listFeedback();

    expect(feedback.id).toMatch(/^feedback_/);
    expect(allFeedback.some((item) => item.id === feedback.id && item.message === feedback.message)).toBe(true);
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

  it("records OpenRouter attempt timings across retries", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "{\"ok\":true}" } }],
            usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.0001 }
          }),
          { status: 200 }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const config = loadDebateRuntimeConfig({
      POLYVISE_ENABLE_MOCK_LLM: "false",
      POLYVISE_YES_MODEL: "openai/gpt-4o-mini",
      POLYVISE_LLM_MAX_ATTEMPTS: "2",
      POLYVISE_API_RETRY_BASE_DELAY_MS: "1"
    });
    const provider = new OpenRouterLlmProvider(config, "test-openrouter-key");
    const result = await provider.generateStructured<{ ok: boolean }>({
      role: "yes frog claim builder",
      schemaName: "testSchema",
      prompt: "{\"ok\":true}",
      jsonSchema: { type: "object" }
    });

    expect(result.data).toEqual({ ok: true });
    expect(result.snapshot.attempts?.map((attempt) => attempt.status)).toEqual(["failed", "ok"]);
    expect(result.snapshot.attempts?.map((attempt) => attempt.mode)).toEqual(["json_schema", "json_schema"]);
    expect(result.snapshot.latencyMs).toBeGreaterThanOrEqual(
      result.snapshot.attempts?.reduce((total, attempt) => total + attempt.durationMs, 0) ?? 0
    );
  });

  it("builds curated model options from configured defaults", () => {
    const config = loadDebateRuntimeConfig({
      POLYVISE_YES_MODEL: "openai/gpt-4o-mini",
      POLYVISE_NO_MODEL: "anthropic/claude-3.5-haiku",
      POLYVISE_JUDGE_MODEL: "google/gemini-flash-1.5",
      POLYVISE_OPENROUTER_MODEL_OPTIONS: "openai/gpt-4o-mini,google/gemini-flash-1.5"
    });
    const modelOptions = modelOptionsFromConfig(config);

    expect(modelOptions.defaults).toEqual({
      yes: "openai/gpt-4o-mini",
      no: "anthropic/claude-3.5-haiku",
      judge: "google/gemini-flash-1.5"
    });
    expect(modelOptions.options.map((option) => option.id)).toContain("anthropic/claude-3.5-haiku");
  });

  it("uses Debatefrog's default model lineup", () => {
    const modelOptions = modelOptionsFromConfig(loadDebateRuntimeConfig({}));

    expect(modelOptions.defaults).toEqual({
      yes: "google/gemini-2.5-flash",
      no: "google/gemini-2.5-flash",
      judge: "openai/gpt-4o-mini"
    });
  });

  it("keeps multiple selectable models when all role defaults match", () => {
    const config = loadDebateRuntimeConfig({
      POLYVISE_YES_MODEL: "openai/gpt-4o-mini",
      POLYVISE_NO_MODEL: "openai/gpt-4o-mini",
      POLYVISE_JUDGE_MODEL: "openai/gpt-4o-mini"
    });
    const optionIds = modelOptionsFromConfig(config).options.map((option) => option.id);

    expect(optionIds).toContain("openai/gpt-4o-mini");
    expect(optionIds).toContain("openai/gpt-4.1");
    expect(optionIds).toContain("google/gemini-2.5-pro");
    expect(optionIds.length).toBeGreaterThan(1);
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

  it("uses role-specific models for duo debates", async () => {
    const run = await runHybridCouncilDebate("debate_duo_models_test", {
      subject: "Should schools have longer recess for kids?",
      councilSize: "duo",
      models: {
        yes: "openai/yes-model",
        no: "anthropic/no-model",
        judge: "google/judge-model"
      }
    });

    expect(run.teams.pro[0].model).toBe("openai/yes-model");
    expect(run.teams.con[0].model).toBe("anthropic/no-model");
    expect(run.teams.judge.model).toContain("google/judge-model");
    expect(run.modelSnapshots.some((snapshot) => snapshot.id === "polyvise-yes" && snapshot.model === "openai/yes-model")).toBe(true);
    expect(run.modelSnapshots.some((snapshot) => snapshot.id === "polyvise-no" && snapshot.model === "anthropic/no-model")).toBe(true);
  });

  it("can produce a NO fallback verdict instead of defaulting close calls to YES", async () => {
    const run = await runHybridCouncilDebate("debate_no_verdict_test", {
      subject: "Should kids be allowed to vote in a political election?",
      councilSize: "duo"
    });

    expect(["conditional_no", "lean_no"]).toContain(run.scorecard.recommendation);
  });

  it("does not give broad pets-at-school policies a confident YES without safeguards", async () => {
    class OverconfidentPetsJudgeProvider extends MockLlmProvider {
      override async generateStructured<T>(request: LlmRequest): Promise<{ data: T; snapshot: ModelSnapshot }> {
        const result = await super.generateStructured<Record<string, unknown>>(request);
        if (request.schemaName === "claimOutput") {
          const side = request.role.toLowerCase().includes("no frog") ? "con" : "pro";
          return {
            data: {
              claims: [
                side === "pro"
                  ? {
                      side: "pro",
                      text: "Pets can provide emotional support and help students feel motivated in school.",
                      warrant: "Feeling good can make learning more enjoyable.",
                      evidenceSourceIds: [],
                      confidence: 0.74
                    }
                  : {
                      side: "con",
                      text: "Broadly allowing pets in school creates allergy, hygiene, supervision, food-service, and distraction risks.",
                      warrant: "Schools need rules that work for all students, not only students who like pets.",
                      evidenceSourceIds: [],
                      confidence: 0.82
                    },
                side === "pro"
                  ? {
                      side: "pro",
                      text: "Pets can teach responsibility and make school feel happier.",
                      warrant: "Students may engage more when school feels warm and fun.",
                      evidenceSourceIds: [],
                      confidence: 0.7
                    }
                  : {
                      side: "con",
                      text: "Pets at school can create fear, bites, liability, and unequal access for students with allergies or phobias.",
                      warrant: "A school-wide rule has to work safely for every classroom and family.",
                      evidenceSourceIds: [],
                      confidence: 0.8
                    }
              ]
            } as T,
            snapshot: result.snapshot
          };
        }

        if (request.schemaName === "judgeScorecardOutput") {
          return {
            data: {
              recommendation: "lean_yes",
              confidence: 0.7,
              categories: [
                { name: "evidence", pro: 7, con: 6, note: "Pets may help some students." },
                { name: "practicality", pro: 7, con: 6, note: "Schools could try it." },
                { name: "risk", pro: 7, con: 6, note: "Risks exist but benefits sound good." },
                { name: "fairness", pro: 7, con: 6, note: "Many students like pets." },
                { name: "reversibility", pro: 7, con: 6, note: "Rules could change." }
              ]
            } as T,
            snapshot: result.snapshot
          };
        }

        if (request.schemaName === "debateTurnOutput" && request.role.toLowerCase().includes("yes frog")) {
          const turnResult = result as { data: { turns?: Array<{ content: string }> }; snapshot: ModelSnapshot };
          if (Array.isArray(turnResult.data.turns)) {
            return {
              data: {
                ...turnResult.data,
                turns: turnResult.data.turns.map((turn) => ({
                  ...turn,
                  content:
                    "Schools could implement safeguards similar to therapy dog programs, and pets can still help kids feel motivated."
                }))
              } as T,
              snapshot: result.snapshot
            };
          }
        }

        return result as { data: T; snapshot: ModelSnapshot };
      }
    }

    const run = await runHybridCouncilDebate(
      "debate_pets_school_judge_test",
      {
        subject: "Should pets be allowed at school?",
        councilSize: "duo"
      },
      undefined,
      { provider: new OverconfidentPetsJudgeProvider() }
    );

    expect(run.scorecard.recommendation).toBe("conditional_no");
    expect(run.scorecard.confidence).toBeLessThanOrEqual(0.6);
    expect(run.scorecard.categories.find((category) => category.name === "risk")?.note).toContain(
      "pets-at-school"
    );
  });

  it("turns broad pets-at-school near-ties into a conditional NO when risks are unanswered", async () => {
    class MixedPetsJudgeProvider extends MockLlmProvider {
      override async generateStructured<T>(request: LlmRequest): Promise<{ data: T; snapshot: ModelSnapshot }> {
        const result = await super.generateStructured<Record<string, unknown>>(request);
        if (request.schemaName === "claimOutput") {
          const side = request.role.toLowerCase().includes("no frog") ? "con" : "pro";
          return {
            data: {
              claims: [
                side === "pro"
                  ? {
                      side: "pro",
                      text: "Pets can make students feel happier and more motivated at school.",
                      warrant: "Better feelings can support engagement.",
                      evidenceSourceIds: [],
                      confidence: 0.73
                    }
                  : {
                      side: "con",
                      text: "Pets at school create allergy, hygiene, supervision, food-service, liability, fear, and distraction risks.",
                      warrant: "A broad school policy has to work safely for all classrooms.",
                      evidenceSourceIds: [],
                      confidence: 0.78
                    }
              ]
            } as T,
            snapshot: result.snapshot
          };
        }

        if (request.schemaName === "judgeScorecardOutput") {
          return {
            data: {
              recommendation: "mixed",
              confidence: 0.64,
              categories: [
                { name: "evidence", pro: 7, con: 7, note: "Both sides have some evidence." },
                { name: "practicality", pro: 7, con: 7, note: "Implementation is uncertain." },
                { name: "risk", pro: 7, con: 7, note: "Risks are present." },
                { name: "fairness", pro: 7, con: 7, note: "Students differ." },
                { name: "reversibility", pro: 7, con: 7, note: "Rules could change." }
              ]
            } as T,
            snapshot: result.snapshot
          };
        }

        if (request.schemaName === "debateTurnOutput" && request.role.toLowerCase().includes("yes frog")) {
          const turnResult = result as { data: { turns?: Array<{ content: string }> }; snapshot: ModelSnapshot };
          if (Array.isArray(turnResult.data.turns)) {
            return {
              data: {
                ...turnResult.data,
                turns: turnResult.data.turns.map((turn) => ({
                  ...turn,
                  content:
                    "Schools could implement safeguards similar to therapy dog programs, and pets can still help kids feel motivated."
                }))
              } as T,
              snapshot: result.snapshot
            };
          }
        }

        return result as { data: T; snapshot: ModelSnapshot };
      }
    }

    const run = await runHybridCouncilDebate(
      "debate_pets_school_mixed_test",
      {
        subject: "Should pets be allowed at school?",
        councilSize: "duo"
      },
      undefined,
      { provider: new MixedPetsJudgeProvider() }
    );

    expect(run.scorecard.recommendation).toBe("conditional_no");
    expect(run.scorecard.confidence).toBeGreaterThanOrEqual(0.62);
    expect(run.scorecard.confidence).toBeLessThanOrEqual(0.66);
  });

  it("defaults to the quartet shape when councilSize is omitted", async () => {
    const run = await runHybridCouncilDebate("debate_default_test", {
      subject: "Should remote work be the default for software teams?"
    });
    expect(run.teams.pro).toHaveLength(2);
    expect(run.teams.con).toHaveLength(2);
  });

  it("polishes common generated grammar glitches before storing turns", async () => {
    class BadGrammarProvider extends MockLlmProvider {
      override async generateStructured<T>(request: LlmRequest): Promise<{ data: T; snapshot: ModelSnapshot }> {
        const result = await super.generateStructured<{ turns?: Array<{ content: string }> }>(request);
        if (request.schemaName !== "debateTurnOutput" || !Array.isArray(result.data.turns)) {
          return result as { data: T; snapshot: ModelSnapshot };
        }

        return {
          data: {
            ...result.data,
            turns: result.data.turns.map((turn) => ({
              ...turn,
              content: 'You says that "Longer recess helps kids"; however, what about school resources?'
            }))
          } as T,
          snapshot: result.snapshot
        };
      }
    }

    const run = await runHybridCouncilDebate(
      "debate_grammar_test",
      {
        subject: "Should schools have longer recess for kids?",
        councilSize: "duo"
      },
      undefined,
      { provider: new BadGrammarProvider() }
    );

    expect(run.turns.some((turn) => turn.content.includes("You says"))).toBe(false);
    expect(run.turns.some((turn) => turn.content.includes("You said"))).toBe(true);
  });

  it("does not accept a generated duo turn for the wrong frog side", async () => {
    class WrongSideProvider extends MockLlmProvider {
      override async generateStructured<T>(request: LlmRequest): Promise<{ data: T; snapshot: ModelSnapshot }> {
        const result = await super.generateStructured<{ turns?: Array<{ agentId: string; agentName: string; side: string; content: string }> }>(request);
        if (request.schemaName !== "debateTurnOutput" || !request.role.toLowerCase().includes("no frog") || !Array.isArray(result.data.turns)) {
          return result as { data: T; snapshot: ModelSnapshot };
        }

        return {
          data: {
            ...result.data,
            turns: result.data.turns.map((turn) => ({
              ...turn,
              agentId: "wrong_yes_agent",
              agentName: "Wrong Yes Frog",
              side: "pro",
              content: "I think YES even though this was the NO frog batch."
            }))
          } as T,
          snapshot: result.snapshot
        };
      }
    }

    const run = await runHybridCouncilDebate(
      "debate_wrong_side_test",
      {
        subject: "Should schools have longer recess for kids?",
        councilSize: "duo"
      },
      undefined,
      { provider: new WrongSideProvider() }
    );

    const openingTurns = run.turns.filter((turn) => turn.round === "opening");
    expect(openingTurns.filter((turn) => turn.side === "pro")).toHaveLength(1);
    expect(openingTurns.filter((turn) => turn.side === "con")).toHaveLength(1);
    expect(openingTurns.some((turn) => turn.agentId === "wrong_yes_agent")).toBe(false);
  });

  it("normalizes nullable high-stakes disclaimers from final summaries", async () => {
    class NullableSummaryProvider extends MockLlmProvider {
      override async generateStructured<T>(request: LlmRequest): Promise<{ data: T; snapshot: ModelSnapshot }> {
        const result = await super.generateStructured<Record<string, unknown>>(request);
        if (request.schemaName !== "finalSummaryOutput") {
          return result as { data: T; snapshot: ModelSnapshot };
        }

        return {
          data: {
            ...result.data,
            highStakesDisclaimer: null
          } as T,
          snapshot: result.snapshot
        };
      }
    }

    const run = await runHybridCouncilDebate(
      "debate_nullable_summary_test",
      {
        subject: "Should schools have longer recess for kids?",
        councilSize: "duo"
      },
      undefined,
      { provider: new NullableSummaryProvider() }
    );

    expect(run.status).toBe("complete");
    expect(run.summary.highStakesDisclaimer).toBeUndefined();
  });

  it("normalizes percentage confidence values from final summaries", async () => {
    class PercentConfidenceSummaryProvider extends MockLlmProvider {
      override async generateStructured<T>(request: LlmRequest): Promise<{ data: T; snapshot: ModelSnapshot }> {
        const result = await super.generateStructured<Record<string, unknown>>(request);
        if (request.schemaName !== "finalSummaryOutput") {
          return result as { data: T; snapshot: ModelSnapshot };
        }

        return {
          data: {
            ...result.data,
            confidence: 72
          } as T,
          snapshot: result.snapshot
        };
      }
    }

    const run = await runHybridCouncilDebate(
      "debate_percent_summary_test",
      {
        subject: "Should schools have longer recess for kids?",
        councilSize: "duo"
      },
      undefined,
      { provider: new PercentConfidenceSummaryProvider() }
    );

    expect(run.status).toBe("complete");
    expect(run.summary.confidence).toBe(0.72);
  });

  it("uses the scorecard confidence when final summaries omit confidence", async () => {
    class MissingConfidenceSummaryProvider extends MockLlmProvider {
      override async generateStructured<T>(request: LlmRequest): Promise<{ data: T; snapshot: ModelSnapshot }> {
        const result = await super.generateStructured<Record<string, unknown>>(request);
        if (request.schemaName !== "finalSummaryOutput") {
          return result as { data: T; snapshot: ModelSnapshot };
        }

        const { confidence: _confidence, ...withoutConfidence } = result.data;
        return {
          data: withoutConfidence as T,
          snapshot: result.snapshot
        };
      }
    }

    const run = await runHybridCouncilDebate(
      "debate_missing_summary_confidence_test",
      {
        subject: "Should schools have longer recess for kids?",
        councilSize: "duo"
      },
      undefined,
      { provider: new MissingConfidenceSummaryProvider() }
    );

    expect(run.status).toBe("complete");
    expect(run.summary.confidence).toBe(run.scorecard.confidence);
  });
});
