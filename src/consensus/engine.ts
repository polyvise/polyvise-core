import { collectEvidenceWithDiagnostics } from "../providers/search";
import { createDefaultLlmProvider, type LlmProvider } from "../providers/llm";
import { loadDebateRuntimeConfig, modelRosterFromConfig, type DebateRuntimeConfig } from "../debate/config";
import { frameDebateRequest, type FramedDebate } from "../debate/engine";
import type {
  DebateEvent,
  DebateRequest,
  EvidenceSource,
  ModelSnapshot,
  PlaceholderInfo,
  RunArtifact,
  RunPlaceholders,
  RunTraceEntry
} from "../debate/types";
import {
  average,
  buildFramingPrompt,
  generateStructured,
  makeId,
  mergeModelSnapshots,
  now,
  pushEvent,
  runStep,
  type StageCopy
} from "../runs/execution";
import type {
  ConsensusAgent,
  ConsensusConvergence,
  ConsensusHoldout,
  ConsensusPosition,
  ConsensusResult,
  ConsensusRound,
  ConsensusRunEnvelope,
  ConsensusStance,
  ConsensusSummary
} from "../runs/types";
import {
  consensusPanelOutputSchema,
  consensusPositionOutputSchema,
  consensusSummaryOutputSchema
} from "./schema";

const DEFAULT_AGENT_COUNT = 5;
const DEFAULT_ROUNDS = 3;
const DEFAULT_CONVERGENCE_THRESHOLD = 0.25;

/**
 * Ordinal stance values. Evenly spaced on 0..1 so the standard deviation of a
 * round is directly interpretable as disagreement.
 */
const stanceValue: Record<ConsensusStance, number> = {
  strongly_agree: 1,
  agree: 0.75,
  neutral: 0.5,
  disagree: 0.25,
  strongly_disagree: 0
};

const stageCopy: StageCopy = {
  queued: {
    label: "Consensus run queued",
    detail: "The subject was accepted and a consensus panel was initialized."
  },
  framing: {
    label: "Panel assembled",
    detail: "The question was framed and independent agents were given their lenses."
  },
  researching: {
    label: "Evidence gathered",
    detail: "Sources were collected, graded, and shared with every agent."
  },
  debating: {
    label: "Agents answered and revised",
    detail: "Each agent answered alone, then revised across rounds after seeing the others."
  },
  judging: {
    label: "Convergence measured",
    detail: "Stance spread was computed per round and the settled range was written up."
  },
  complete: {
    label: "Consensus run complete",
    detail: "The convergence curve, per-round positions, and dissent record are ready."
  }
};

/**
 * The deterministic lens roster. Used as the fallback panel and as the shape
 * the model is asked to match, so a failed panel-builder call still produces a
 * usable spread of viewpoints rather than five identical agents.
 */
const fallbackLenses = [
  { name: "Evidence reader", lens: "What the strongest available data actually supports" },
  { name: "Systems thinker", lens: "Second-order effects and how the parts interact over time" },
  { name: "Practitioner", lens: "What implementing this would really cost and require" },
  { name: "Risk analyst", lens: "Failure modes, worst cases, and who absorbs them" },
  { name: "Ethicist", lens: "Who is affected, who decides, and whether that is fair" },
  { name: "Economist", lens: "Incentives, tradeoffs, and opportunity cost" },
  { name: "Skeptic", lens: "Where the case is weakest and what would falsify it" }
];

export type ConsensusEventEmitter = (event: ConsensusLiveEvent) => void;

/**
 * Live events for a consensus run. Separate from `DebateLiveEvent` because the
 * payloads genuinely differ — there are no teams, turns or scorecard here.
 */
export type ConsensusLiveEvent =
  | { kind: "stage"; status: ConsensusRunEnvelope["status"] }
  | { kind: "framed"; resolution: string; topicKind: FramedDebate["topicKind"]; highStakes: FramedDebate["highStakes"] }
  | { kind: "agents"; agents: ConsensusAgent[]; placeholder?: PlaceholderInfo }
  | { kind: "sources"; sources: EvidenceSource[] }
  | { kind: "round"; round: ConsensusRound; placeholder?: PlaceholderInfo }
  | { kind: "convergence"; convergence: ConsensusConvergence }
  | { kind: "summary"; summary: ConsensusSummary; holdouts: ConsensusHoldout[]; placeholder?: PlaceholderInfo }
  | { kind: "model_snapshot"; snapshot: ModelSnapshot }
  | { kind: "complete"; runId: string }
  | { kind: "error"; message: string };

export interface ConsensusExecutionOptions {
  provider?: LlmProvider;
  config?: DebateRuntimeConfig;
  emit?: ConsensusEventEmitter;
}

export async function runConsensus(
  debateId: string,
  request: DebateRequest,
  framed: FramedDebate = frameDebateRequest(request),
  options: ConsensusExecutionOptions = {}
): Promise<ConsensusRunEnvelope> {
  const config = options.config ?? configForRequest(loadDebateRuntimeConfig(), request);
  const provider = options.provider ?? createDefaultLlmProvider(config);
  const emit = options.emit ?? (() => {});

  const runId = makeId("run");
  const startedAt = now();
  const events: DebateEvent[] = [];
  const trace: RunTraceEntry[] = [];
  const snapshots: ModelSnapshot[] = [];
  const placeholders: RunPlaceholders = {};

  const agentCount = clamp(request.consensus?.agentCount ?? DEFAULT_AGENT_COUNT, 3, 7);
  const roundCount = clamp(request.consensus?.rounds ?? DEFAULT_ROUNDS, 2, 5);
  const threshold = clampFloat(request.consensus?.convergenceThreshold ?? DEFAULT_CONVERGENCE_THRESHOLD, 0, 1);

  const recordSnapshot = (snapshot: ModelSnapshot) => {
    snapshots.push(snapshot);
    emit({ kind: "model_snapshot", snapshot });
  };

  pushEvent(events, debateId, runId, "queued", stageCopy);
  emit({ kind: "stage", status: "queued" });
  await runStep(trace, "frame", async () => `Classified as ${framed.topicKind}.`);
  emit({
    kind: "framed",
    resolution: framed.resolution,
    topicKind: framed.topicKind,
    highStakes: framed.highStakes
  });

  /* ---------------------------------------------------------- panel build */

  pushEvent(events, debateId, runId, "framing", stageCopy);
  emit({ kind: "stage", status: "framing" });

  let agentsPlaceholder: PlaceholderInfo | null = null;
  const agents = await runStep(trace, "panel_builder", async () => {
    const fallback = { agents: fallbackLenses.slice(0, agentCount).map(({ name, lens }) => ({ name, lens })) };
    const { data, snapshot, placeholder } = await generateStructured(
      provider,
      "consensus panel builder",
      "consensusPanelOutput",
      fallback,
      consensusPanelOutputSchema,
      config,
      buildFramingPrompt({
        task: `Create exactly ${agentCount} agents who will answer this question independently. Each needs a distinct analytical lens. Do NOT assign anyone a position to defend — they must be free to reach any conclusion.`,
        subject: framed.subject,
        resolution: framed.resolution,
        context: framed.context,
        fallback
      }),
      runId
    );
    recordSnapshot(snapshot);
    agentsPlaceholder = placeholder;

    const built: ConsensusAgent[] = data.agents.slice(0, agentCount).map((agent) => ({
      id: makeId("agent"),
      name: agent.name,
      lens: agent.lens,
      model: provider.modelForRole("consensus agent")
    }));

    return { message: `${built.length} agents assembled with distinct lenses.`, value: built };
  });
  if (agentsPlaceholder) placeholders.scouts = agentsPlaceholder;
  emit({ kind: "agents", agents, ...(agentsPlaceholder ? { placeholder: agentsPlaceholder } : {}) });

  /* ------------------------------------------------------------- evidence */

  pushEvent(events, debateId, runId, "researching", stageCopy);
  emit({ kind: "stage", status: "researching" });
  const sources = await runStep(trace, "evidence", async () => {
    const { sources: collected, diagnostic } = await collectEvidenceWithDiagnostics(
      framed.subject,
      framed.topicKind,
      config
    );
    const liveProvider = collected.find((source) => source.retrievedVia !== "mock")?.retrievedVia;
    return {
      status: liveProvider ? ("ok" as const) : ("warning" as const),
      message: liveProvider
        ? `Live ${liveProvider} search evidence was attached.`
        : `Using deterministic development evidence. ${diagnostic ?? "No live search provider returned sources."}`,
      value: collected
    };
  });
  emit({ kind: "sources", sources });

  /* --------------------------------------------------------------- rounds */

  pushEvent(events, debateId, runId, "debating", stageCopy);
  emit({ kind: "stage", status: "debating" });

  const rounds: ConsensusRound[] = [];

  for (let roundNumber = 1; roundNumber <= roundCount; roundNumber += 1) {
    const previous = rounds[rounds.length - 1];
    let roundPlaceholder: PlaceholderInfo | null = null;

    const positions = await runStep(trace, roundNumber === 1 ? "answer" : "revise", async () => {
      const collected: ConsensusPosition[] = [];

      // One call per agent. Round 1 is the whole point of the mode — an agent
      // that saw the others first would not be answering independently — and
      // keeping the same shape in later rounds means one agent's failure
      // cannot take the rest of the panel down with it.
      for (const agent of agents) {
        const priorSelf = previous?.positions.find((position) => position.agentId === agent.id);
        const fallback = {
          positions: [
            {
              agentId: agent.id,
              agentName: agent.name,
              stance: priorSelf?.stance ?? ("neutral" as ConsensusStance),
              answer: priorSelf?.answer ?? `Unresolved from the ${agent.lens.toLowerCase()} view.`,
              rationale:
                priorSelf?.rationale ?? `No model output was available for the ${agent.lens.toLowerCase()} lens.`,
              confidence: priorSelf?.confidence ?? 0.3,
              sourceIds: priorSelf?.sourceIds ?? []
            }
          ]
        };

        const { data, snapshot, placeholder } = await generateStructured(
          provider,
          `consensus agent ${agent.lens}`,
          "consensusPositionOutput",
          fallback,
          consensusPositionOutputSchema,
          config,
          buildRoundPrompt({ framed, sources, agent, roundNumber, previous, fallback }),
          runId
        );
        recordSnapshot(snapshot);
        roundPlaceholder = roundPlaceholder ?? placeholder;

        const raw = data.positions[0];
        const stance = raw.stance;
        collected.push({
          id: makeId("position"),
          agentId: agent.id,
          agentName: agent.name,
          round: roundNumber,
          stance,
          answer: raw.answer,
          rationale: raw.rationale,
          confidence: raw.confidence,
          // Derived, not taken on the model's word.
          changedFromPrevious: priorSelf ? priorSelf.stance !== stance : false,
          sourceIds: raw.sourceIds,
          ...(placeholder ? {} : { model: snapshot.model })
        });
      }

      const moved = collected.filter((position) => position.changedFromPrevious).length;
      return {
        message:
          roundNumber === 1
            ? `${collected.length} agents answered independently.`
            : `${moved} of ${collected.length} agents moved in round ${roundNumber}.`,
        value: collected
      };
    });

    const round: ConsensusRound = {
      round: roundNumber,
      positions,
      spread: spreadOf(positions)
    };
    rounds.push(round);
    if (roundPlaceholder) {
      placeholders.turns = { ...placeholders.turns, [roundKey(roundNumber)]: roundPlaceholder };
    }
    emit({ kind: "round", round, ...(roundPlaceholder ? { placeholder: roundPlaceholder } : {}) });
  }

  /* --------------------------------------------------- convergence + write */

  pushEvent(events, debateId, runId, "judging", stageCopy);
  emit({ kind: "stage", status: "judging" });

  const finalRound = rounds[rounds.length - 1];
  const modal = modalStance(finalRound.positions);
  const dissenters = finalRound.positions.filter((position) => position.stance !== modal);

  let summaryPlaceholder: PlaceholderInfo | null = null;
  const written = await runStep(trace, "converge", async () => {
    const fallback = {
      headline: `The panel settled ${finalRound.spread <= threshold ? "into agreement" : "without converging"}.`,
      finding: `After ${rounds.length} rounds the panel's stance spread was ${finalRound.spread.toFixed(2)}.`,
      finalAnswer: finalRound.positions[0]?.answer ?? "No answer was produced.",
      range: describeRange(finalRound.positions),
      agreed: [] as string[],
      contested: [] as string[],
      unresolvedUncertainties: [] as string[],
      holdoutReasons: dissenters.map((position) => ({
        agentId: position.agentId,
        reason: `Held a ${readableStance(position.stance)} position while the panel settled on ${readableStance(modal)}.`
      })),
      confidence: Math.round((1 - finalRound.spread) * 100),
      highStakesDisclaimer: framed.highStakes?.message ?? null
    };

    const { data, snapshot, placeholder } = await generateStructured(
      provider,
      "consensus summary",
      "consensusSummaryOutput",
      fallback,
      consensusSummaryOutputSchema,
      config,
      buildSummaryPrompt({ framed, sources, rounds, modal, dissenters, threshold, fallback }),
      runId
    );
    recordSnapshot(snapshot);
    summaryPlaceholder = placeholder;
    return { message: `Consensus written up over ${rounds.length} rounds.`, value: data };
  });
  if (summaryPlaceholder) placeholders.summary = summaryPlaceholder;

  const convergence: ConsensusConvergence = {
    converged: finalRound.spread <= threshold,
    finalAnswer: written.finalAnswer,
    agreementLevel: round2(1 - finalRound.spread),
    range: written.range,
    spreadByRound: rounds.map((entry) => entry.spread)
  };
  emit({ kind: "convergence", convergence });

  // Reasons come from the model, but membership does not: an entry for an
  // agent that actually agreed is dropped rather than reported as dissent.
  const reasonFor = new Map(written.holdoutReasons.map((entry) => [entry.agentId, entry.reason]));
  const holdouts: ConsensusHoldout[] = dissenters.map((position) => ({
    agentId: position.agentId,
    agentName: position.agentName,
    stance: position.stance,
    position: position.answer,
    reason:
      reasonFor.get(position.agentId) ??
      `Held a ${readableStance(position.stance)} position while the panel settled on ${readableStance(modal)}.`
  }));

  const summary: ConsensusSummary = {
    headline: written.headline,
    finding: written.finding,
    agreed: written.agreed,
    contested: written.contested,
    unresolvedUncertainties: written.unresolvedUncertainties,
    confidence: written.confidence ?? Math.round(convergence.agreementLevel * 100),
    ...(written.highStakesDisclaimer ? { highStakesDisclaimer: written.highStakesDisclaimer } : {})
  };
  emit({
    kind: "summary",
    summary,
    holdouts,
    ...(summaryPlaceholder ? { placeholder: summaryPlaceholder } : {})
  });

  pushEvent(events, debateId, runId, "complete", stageCopy);
  emit({ kind: "stage", status: "complete" });
  emit({ kind: "complete", runId });

  const modelSnapshots = mergeModelSnapshots(modelRosterFromConfig(config), snapshots);
  const result: ConsensusResult = { mode: "consensus", agents, rounds, convergence, holdouts, summary };

  await runStep(trace, "persist", async () => "Consensus run assembled for repository persistence.");

  return {
    id: runId,
    debateId,
    status: "complete",
    startedAt,
    completedAt: now(),
    events,
    sources,
    modelSnapshots,
    artifactManifest: buildArtifactManifest({ agents, rounds, sources, modelSnapshots }),
    trace,
    placeholders,
    result
  };
}

function configForRequest(config: DebateRuntimeConfig, request: DebateRequest): DebateRuntimeConfig {
  return {
    ...config,
    quickModel: request.models?.quick?.trim() || config.quickModel,
    deepModel: request.models?.deep?.trim() || config.deepModel,
    judgeModel: request.models?.judge?.trim() || config.judgeModel
  };
}

function buildRoundPrompt(input: {
  framed: FramedDebate;
  sources: EvidenceSource[];
  agent: ConsensusAgent;
  roundNumber: number;
  previous?: ConsensusRound;
  fallback: unknown;
}): string {
  const { framed, sources, agent, roundNumber, previous, fallback } = input;

  const task =
    roundNumber === 1
      ? `You are "${agent.name}". Your lens: ${agent.lens}. Answer the resolution independently. You have not seen anyone else's answer and must not guess at one. Reach whatever conclusion the evidence and your lens support — agreeing with an imagined majority is a failure. Set "stance" to your honest position on the resolution.`
      : `You are "${agent.name}". Your lens: ${agent.lens}. You have now seen the other agents' answers from round ${roundNumber - 1}. Revise your position ONLY if their reasoning actually changed your mind. Holding your position against the majority is a legitimate outcome and is preferred over drifting toward agreement for its own sake. Set "stance" to your position after considering theirs.`;

  const lines = [
    buildFramingPrompt({
      task,
      subject: framed.subject,
      resolution: framed.resolution,
      context: framed.context,
      sources,
      fallback
    })
  ];

  if (previous) {
    const self = previous.positions.find((position) => position.agentId === agent.id);
    if (self) {
      lines.push(
        "",
        `YOUR PREVIOUS POSITION (round ${previous.round}): [${self.stance}] ${self.answer}`,
        `YOUR PREVIOUS REASONING: ${self.rationale}`
      );
    }

    const others = previous.positions.filter((position) => position.agentId !== agent.id);
    if (others.length) {
      lines.push("", `OTHER AGENTS IN ROUND ${previous.round}:`);
      for (const position of others) {
        lines.push(`- ${position.agentName} [${position.stance}]: ${position.answer} — ${position.rationale}`);
      }
    }
  }

  lines.push("", 'Return exactly one entry in "positions", for yourself only.');
  return lines.join("\n");
}

function buildSummaryPrompt(input: {
  framed: FramedDebate;
  sources: EvidenceSource[];
  rounds: ConsensusRound[];
  modal: ConsensusStance;
  dissenters: ConsensusPosition[];
  threshold: number;
  fallback: unknown;
}): string {
  const { framed, sources, rounds, modal, dissenters, threshold, fallback } = input;
  const finalRound = rounds[rounds.length - 1];

  const lines = [
    buildFramingPrompt({
      task: `Write up what this panel actually concluded. Report the range of positions honestly — if the panel did not converge, say so plainly rather than manufacturing a consensus. "finalAnswer" must reflect the majority position, and "range" must describe the spread including any dissent. Do not describe dissenting agents as mistaken.`,
      subject: framed.subject,
      resolution: framed.resolution,
      context: framed.context,
      sources,
      fallback
    }),
    "",
    `ROUNDS RUN: ${rounds.length}`,
    `STANCE SPREAD BY ROUND (0 = total agreement): ${rounds.map((round) => round.spread.toFixed(2)).join(", ")}`,
    `CONVERGENCE THRESHOLD: ${threshold.toFixed(2)} — the panel ${finalRound.spread <= threshold ? "DID" : "DID NOT"} converge.`,
    `MAJORITY STANCE: ${modal}`,
    "",
    "FINAL POSITIONS:"
  ];

  for (const position of finalRound.positions) {
    lines.push(`- ${position.agentName} [${position.stance}]: ${position.answer} — ${position.rationale}`);
  }

  if (dissenters.length) {
    lines.push(
      "",
      `DISSENTERS (still outside the majority): ${dissenters.map((position) => position.agentName).join(", ")}.`,
      'Give a reason for each in "holdoutReasons", keyed by agentId.'
    );
  } else {
    lines.push("", 'No agent dissented. Return an empty "holdoutReasons".');
  }

  return lines.join("\n");
}

/**
 * Disagreement across a round, 0..1.
 *
 * Standard deviation of the ordinal stance values, doubled: stance values span
 * 0..1, so the most polarized possible round (half at each extreme) has a
 * standard deviation of 0.5 and maps to a spread of exactly 1.
 */
export function spreadOf(positions: Array<{ stance: ConsensusStance }>): number {
  if (positions.length < 2) {
    return 0;
  }

  const values = positions.map((position) => stanceValue[position.stance]);
  const mean = average(values);
  const variance = average(values.map((value) => (value - mean) ** 2));
  return round2(Math.min(1, Math.sqrt(variance) * 2));
}

/**
 * The most common stance.
 *
 * Ties break toward the stance nearest the panel mean, which settles a
 * three-or-more-way tie. A two-way tie is genuinely ambiguous — the mean of two
 * values is equidistant from both — and resolves to whichever was seen first.
 */
export function modalStance(positions: Array<{ stance: ConsensusStance }>): ConsensusStance {
  const counts = new Map<ConsensusStance, number>();
  for (const position of positions) {
    counts.set(position.stance, (counts.get(position.stance) ?? 0) + 1);
  }

  const mean = average(positions.map((position) => stanceValue[position.stance]));
  let best: ConsensusStance = "neutral";
  let bestCount = -1;

  for (const [stance, count] of counts) {
    if (count > bestCount) {
      best = stance;
      bestCount = count;
      continue;
    }
    if (count === bestCount && Math.abs(stanceValue[stance] - mean) < Math.abs(stanceValue[best] - mean)) {
      best = stance;
    }
  }

  return best;
}

function describeRange(positions: ConsensusPosition[]): string {
  const stances = positions.map((position) => position.stance);
  const unique = Array.from(new Set(stances));
  if (unique.length === 1) {
    return `All ${positions.length} agents landed on ${readableStance(unique[0])}.`;
  }

  const sorted = [...positions].sort((a, b) => stanceValue[b.stance] - stanceValue[a.stance]);
  return `Positions ran from ${readableStance(sorted[0].stance)} to ${readableStance(sorted[sorted.length - 1].stance)}.`;
}

function readableStance(stance: ConsensusStance): string {
  return stance.replace(/_/g, " ");
}

/**
 * Consensus rounds are numbered, but `RunPlaceholders.turns` is keyed by the
 * debate's round names. Mapping onto those names keeps one placeholder shape
 * across modes; the number is what actually identifies the round.
 */
function roundKey(roundNumber: number): "opening" | "cross_examination" | "rebuttal" | "closing" | "judge_review" {
  const keys = ["opening", "cross_examination", "rebuttal", "closing", "judge_review"] as const;
  return keys[Math.min(roundNumber - 1, keys.length - 1)];
}

function buildArtifactManifest(input: {
  agents: ConsensusAgent[];
  rounds: ConsensusRound[];
  sources: EvidenceSource[];
  modelSnapshots: ModelSnapshot[];
}): RunArtifact[] {
  const createdAt = now();
  const positionCount = input.rounds.reduce((total, round) => total + round.positions.length, 0);

  return [
    { id: makeId("artifact"), kind: "run_state", label: "Consensus run state", recordCount: 1, createdAt },
    { id: makeId("artifact"), kind: "lenses", label: "Panel agents", recordCount: input.agents.length, createdAt },
    { id: makeId("artifact"), kind: "evidence", label: "Source ledger", recordCount: input.sources.length, createdAt },
    { id: makeId("artifact"), kind: "positions", label: "Round positions", recordCount: positionCount, createdAt },
    { id: makeId("artifact"), kind: "convergence", label: "Convergence curve", recordCount: input.rounds.length, createdAt },
    { id: makeId("artifact"), kind: "summary", label: "Consensus write-up", recordCount: 1, createdAt },
    {
      id: makeId("artifact"),
      kind: "models",
      label: "Model snapshots",
      recordCount: input.modelSnapshots.length,
      createdAt
    }
  ];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampFloat(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
