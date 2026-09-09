import { describe, expect, it } from "vitest";
import { modalStance, runConsensus, spreadOf } from "@polyvise/core/consensus/engine";
import { runAdvisoryPanel } from "@polyvise/core/panel/engine";
import { runDeliberation, toDebateRun, toRunEnvelope } from "@polyvise/core/runs/dispatch";
import { isAdvisoryPanelRun, isConsensusRun, isHybridCouncilRun } from "@polyvise/core/runs/types";
import { runHybridCouncilDebate } from "@polyvise/core/debate/engine";
import { debateRequestSchema } from "@polyvise/core/debate/schema";
import { loadDebateRuntimeConfig } from "@polyvise/core/debate/config";
import { MockLlmProvider, type LlmProvider, type LlmRequest } from "@polyvise/core/providers/llm";
import type { ModelSnapshot } from "@polyvise/core/debate/types";
import type { ConsensusStance } from "@polyvise/core/runs/types";

const config = {
  ...loadDebateRuntimeConfig(),
  enableMockLlm: true,
  allowDeterministicFallbacks: true,
  evidenceProvider: "mock" as const
};

/**
 * Returns scripted structured output per schema name, so a test can drive the
 * engines to a specific outcome. Anything unscripted falls through to the
 * caller's deterministic fallback, exactly as MockLlmProvider does.
 */
function scriptedProvider(script: Partial<Record<string, (request: LlmRequest) => unknown>>): LlmProvider {
  let call = 0;

  return {
    name: "scripted",
    configured: true,
    modelForRole: () => "scripted-model",
    async generateStructured<T>(request: LlmRequest): Promise<{ data: T; snapshot: ModelSnapshot }> {
      call += 1;
      const handler = script[request.schemaName];
      const data = handler ? handler(request) : (request.fallback as unknown);

      return {
        data: data as T,
        snapshot: {
          id: `scripted-${request.schemaName}-${call}`,
          provider: "local",
          model: "scripted-model",
          role: request.role,
          configured: true
        }
      };
    }
  };
}

function position(agentId: string, agentName: string, stance: ConsensusStance) {
  return {
    agentId,
    agentName,
    stance,
    answer: `${agentName} answer`,
    rationale: `${agentName} rationale`,
    confidence: 0.6,
    sourceIds: []
  };
}

describe("consensus spread", () => {
  it("reports zero spread when every agent holds the same stance", () => {
    expect(spreadOf([{ stance: "agree" }, { stance: "agree" }, { stance: "agree" }])).toBe(0);
  });

  it("reports full spread when the panel is split between the extremes", () => {
    expect(spreadOf([{ stance: "strongly_agree" }, { stance: "strongly_disagree" }])).toBe(1);
  });

  it("treats a lone position as agreement rather than dividing by zero", () => {
    expect(spreadOf([{ stance: "disagree" }])).toBe(0);
  });

  it("grows as the panel spreads out", () => {
    const tight = spreadOf([{ stance: "agree" }, { stance: "strongly_agree" }]);
    const wide = spreadOf([{ stance: "agree" }, { stance: "strongly_disagree" }]);

    expect(tight).toBeGreaterThan(0);
    expect(wide).toBeGreaterThan(tight);
  });
});

describe("modal stance", () => {
  it("picks the most common stance", () => {
    expect(
      modalStance([{ stance: "agree" }, { stance: "agree" }, { stance: "disagree" }])
    ).toBe("agree");
  });

  it("breaks a three-way tie toward the stance nearest the panel mean", () => {
    // All counts are 1, so the mean decides: it sits at 0.67, which "agree"
    // (0.75) is closest to. A two-way tie cannot be broken this way — the mean
    // of two values is equidistant from both — so it resolves to first seen.
    expect(
      modalStance([{ stance: "strongly_agree" }, { stance: "agree" }, { stance: "disagree" }])
    ).toBe("agree");
  });
});

describe("consensus runs", () => {
  it("runs every agent through every round", async () => {
    const run = await runConsensus(
      "debate_consensus",
      { subject: "Should we move billing off a single vendor?", mode: "consensus", consensus: { agentCount: 4, rounds: 3 } },
      undefined,
      { provider: new MockLlmProvider(), config }
    );

    expect(run.result.mode).toBe("consensus");
    expect(run.result.agents).toHaveLength(4);
    expect(run.result.rounds).toHaveLength(3);
    for (const round of run.result.rounds) {
      expect(round.positions).toHaveLength(4);
    }
    expect(run.result.convergence.spreadByRound).toHaveLength(3);
    expect(run.status).toBe("complete");
  });

  it("clamps agent count and rounds to the supported range", async () => {
    const run = await runConsensus(
      "debate_clamp",
      { subject: "Should we ship on Friday?", mode: "consensus", consensus: { agentCount: 99, rounds: 99 } },
      undefined,
      { provider: new MockLlmProvider(), config }
    );

    expect(run.result.agents).toHaveLength(7);
    expect(run.result.rounds).toHaveLength(5);
  });

  it("derives movement from the stance rather than the model's say-so", async () => {
    let round = 0;
    const provider = scriptedProvider({
      consensusPanelOutput: () => ({
        agents: [
          { name: "Alpha", lens: "data" },
          { name: "Beta", lens: "risk" },
          { name: "Gamma", lens: "cost" }
        ]
      }),
      consensusPositionOutput: (request) => {
        // One entry per call, and the engine calls once per agent per round.
        const fallbackAgent = (request.fallback as { positions: Array<{ agentId: string; agentName: string }> })
          .positions[0];
        round += 1;
        // Rounds 1-3 for three agents: everyone opens neutral, then Alpha and
        // Beta move to agree while Gamma stays put.
        const isFirstRound = round <= 3;
        const stance: ConsensusStance = isFirstRound
          ? "neutral"
          : fallbackAgent.agentName === "Gamma"
            ? "neutral"
            : "agree";
        return { positions: [position(fallbackAgent.agentId, fallbackAgent.agentName, stance)] };
      }
    });

    const run = await runConsensus(
      "debate_movement",
      { subject: "Should we adopt a four-day week?", mode: "consensus", consensus: { agentCount: 3, rounds: 2 } },
      undefined,
      { provider, config }
    );

    const [first, second] = run.result.rounds;
    expect(first.positions.every((entry) => entry.changedFromPrevious === false)).toBe(true);

    const moved = second.positions.filter((entry) => entry.changedFromPrevious).map((entry) => entry.agentName);
    expect(moved.sort()).toEqual(["Alpha", "Beta"]);
  });

  it("reports the dissenting agent as a holdout and ignores invented ones", async () => {
    let call = 0;
    const provider = scriptedProvider({
      consensusPanelOutput: () => ({
        agents: [
          { name: "Alpha", lens: "data" },
          { name: "Beta", lens: "risk" },
          { name: "Gamma", lens: "cost" }
        ]
      }),
      consensusPositionOutput: (request) => {
        const fallbackAgent = (request.fallback as { positions: Array<{ agentId: string; agentName: string }> })
          .positions[0];
        call += 1;
        const stance: ConsensusStance = fallbackAgent.agentName === "Gamma" ? "strongly_disagree" : "agree";
        return { positions: [position(fallbackAgent.agentId, fallbackAgent.agentName, stance)] };
      },
      consensusSummaryOutput: (request) => {
        const fallback = request.fallback as Record<string, unknown>;
        return {
          ...fallback,
          headline: "Panel mostly agreed.",
          finding: "Two of three agents agreed.",
          finalAnswer: "Proceed with conditions.",
          range: "agree to strongly disagree",
          agreed: ["Cost is manageable"],
          contested: ["Risk tolerance"],
          unresolvedUncertainties: [],
          // One real dissenter plus an agent id that never sat on this panel.
          holdoutReasons: [
            { agentId: gammaId(), reason: "Cost exposure is unacceptable." },
            { agentId: "agent_invented", reason: "Never sat on this panel." }
          ],
          confidence: 70
        };
      }
    });

    let gamma = "";
    const gammaId = () => gamma;

    // Resolve Gamma's generated id by running once and reading it back.
    const probe = await runConsensus(
      "debate_probe",
      { subject: "Should we outsource support?", mode: "consensus", consensus: { agentCount: 3, rounds: 2 } },
      undefined,
      { provider: scriptedProvider({
          consensusPanelOutput: () => ({
            agents: [
              { name: "Alpha", lens: "data" },
              { name: "Beta", lens: "risk" },
              { name: "Gamma", lens: "cost" }
            ]
          })
        }), config }
    );
    gamma = probe.result.agents.find((agent) => agent.name === "Gamma")!.id;

    const run = await runConsensus(
      "debate_holdout",
      { subject: "Should we outsource support?", mode: "consensus", consensus: { agentCount: 3, rounds: 2 } },
      undefined,
      { provider, config }
    );

    // Membership comes from the stances, so the invented agent is dropped and
    // the real dissenter is kept regardless of what the summary claimed.
    expect(run.result.holdouts).toHaveLength(1);
    expect(run.result.holdouts[0].agentName).toBe("Gamma");
    expect(run.result.holdouts[0].stance).toBe("strongly_disagree");
    expect(run.result.convergence.converged).toBe(false);
  });

  it("counts a unanimous panel as converged", async () => {
    const run = await runConsensus(
      "debate_converged",
      { subject: "Should we keep daily backups?", mode: "consensus", consensus: { agentCount: 3, rounds: 2 } },
      undefined,
      { provider: new MockLlmProvider(), config }
    );

    // The mock returns each caller's fallback, so every agent stays neutral.
    expect(run.result.convergence.converged).toBe(true);
    expect(run.result.convergence.agreementLevel).toBe(1);
    expect(run.result.holdouts).toHaveLength(0);
  });
});

describe("advisory panel runs", () => {
  it("seats all four lenses and collects one piece of advice from each", async () => {
    const run = await runAdvisoryPanel(
      "debate_panel",
      { subject: "Should we rebuild the billing service?", mode: "advisory_panel" },
      undefined,
      { provider: new MockLlmProvider(), config }
    );

    expect(run.result.mode).toBe("advisory_panel");
    expect(run.result.lenses.map((lens) => lens.id)).toEqual(["economist", "ethicist", "operator", "skeptic"]);
    expect(run.result.advice).toHaveLength(4);
    expect(run.result.advice.map((entry) => entry.lensId)).toEqual([
      "economist",
      "ethicist",
      "operator",
      "skeptic"
    ]);
  });

  it("honours a custom lens selection and drops repeats", async () => {
    const run = await runAdvisoryPanel(
      "debate_panel_custom",
      {
        subject: "Should we rebuild the billing service?",
        mode: "advisory_panel",
        panel: { lenses: ["skeptic", "economist", "skeptic"] }
      },
      undefined,
      { provider: new MockLlmProvider(), config }
    );

    expect(run.result.lenses.map((lens) => lens.id)).toEqual(["skeptic", "economist"]);
    expect(run.result.advice).toHaveLength(2);
  });

  it("drops chair findings attributed to lenses that never sat on the panel", async () => {
    const provider = scriptedProvider({
      panelChairOutput: (request) => {
        const fallback = request.fallback as Record<string, unknown>;
        return {
          ...fallback,
          headline: "Split panel.",
          throughLine: "Two lenses advised.",
          agreements: [
            // Valid: both lenses are seated.
            { point: "Cost is the binding constraint", lensIds: ["economist", "skeptic"] },
            // Invalid: ethicist was never seated, leaving one lens.
            { point: "Fairness is settled", lensIds: ["economist", "ethicist"] }
          ],
          conflicts: [
            {
              point: "Timeline",
              positions: [
                { lensId: "economist", stance: "Move now" },
                { lensId: "operator", stance: "Not seated" }
              ]
            }
          ],
          decisionGuidance: "Decide on cost.",
          confidence: 60
        };
      }
    });

    const run = await runAdvisoryPanel(
      "debate_panel_filter",
      {
        subject: "Should we rebuild the billing service?",
        mode: "advisory_panel",
        panel: { lenses: ["economist", "skeptic"] }
      },
      undefined,
      { provider, config }
    );

    expect(run.result.chair.agreements).toHaveLength(1);
    expect(run.result.chair.agreements[0].lensIds).toEqual(["economist", "skeptic"]);
    // The conflict loses its unseated side and falls below two positions.
    expect(run.result.chair.conflicts).toHaveLength(0);
  });
});

describe("mode dispatch", () => {
  it("routes each mode to its own engine", async () => {
    const consensus = await runDeliberation(
      "debate_dispatch_consensus",
      { subject: "Should we move billing off a single vendor?", mode: "consensus", consensus: { agentCount: 3, rounds: 2 } },
      undefined,
      { consensus: { provider: new MockLlmProvider(), config } }
    );
    const panel = await runDeliberation(
      "debate_dispatch_panel",
      { subject: "Should we move billing off a single vendor?", mode: "advisory_panel" },
      undefined,
      { advisoryPanel: { provider: new MockLlmProvider(), config } }
    );
    const debate = await runDeliberation(
      "debate_dispatch_debate",
      { subject: "Should we move billing off a single vendor?" },
      undefined,
      { hybridCouncil: { provider: new MockLlmProvider(), config } }
    );

    expect(isConsensusRun(consensus)).toBe(true);
    expect(isAdvisoryPanelRun(panel)).toBe(true);
    expect(isHybridCouncilRun(debate)).toBe(true);
  });

  it("round-trips a debate run through the envelope without losing anything", async () => {
    const original = await runHybridCouncilDebate(
      "debate_roundtrip",
      { subject: "Should we move billing off a single vendor?" },
      undefined,
      { provider: new MockLlmProvider(), config }
    );

    expect(toDebateRun(toRunEnvelope(original))).toEqual(original);
  });
});

describe("request schema", () => {
  it("still defaults to hybrid council when no mode is given", () => {
    expect(debateRequestSchema.parse({ subject: "Should we ship on Friday?" }).mode).toBe("hybrid_council");
  });

  it("accepts the new modes and their options", () => {
    const consensus = debateRequestSchema.parse({
      subject: "Should we ship on Friday?",
      mode: "consensus",
      consensus: { agentCount: 4, rounds: 2 }
    });
    const panel = debateRequestSchema.parse({
      subject: "Should we ship on Friday?",
      mode: "advisory_panel",
      panel: { lenses: ["economist", "skeptic"] }
    });

    expect(consensus.mode).toBe("consensus");
    expect(consensus.consensus?.agentCount).toBe(4);
    expect(panel.panel?.lenses).toEqual(["economist", "skeptic"]);
  });

  it("rejects an out-of-range agent count", () => {
    expect(
      debateRequestSchema.safeParse({
        subject: "Should we ship on Friday?",
        mode: "consensus",
        consensus: { agentCount: 99 }
      }).success
    ).toBe(false);
  });
});
