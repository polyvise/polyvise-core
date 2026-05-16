import { randomUUID } from "node:crypto";
import { collectEvidence } from "../providers/search";
import { createDefaultLlmProvider, type LlmProvider } from "../providers/llm";
import { loadDebateRuntimeConfig, modelRosterFromConfig, type DebateRuntimeConfig } from "./config";
import {
  claimOutputSchema,
  debateTurnOutputSchema,
  finalSummaryOutputSchema,
  judgeScorecardOutputSchema,
  scoutOutputSchema
} from "./schema";
import { classifyTopic, detectHighStakes, frameResolution } from "./topic";
import type {
  ArgumentEdge,
  ArgumentNode,
  Claim,
  DebateAgent,
  DebateEvent,
  DebateLiveEvent,
  DebateRequest,
  DebateRun,
  DebateTeam,
  EvidenceSource,
  HighStakesNotice,
  ModelSnapshot,
  PlaceholderInfo,
  ProductNote,
  RoundTurn,
  RunArtifact,
  RunTraceEntry,
  Scorecard,
  StanceScout,
  TopicKind
} from "./types";
import { z } from "zod";

type FramedDebate = {
  subject: string;
  context?: string;
  resolution: string;
  topicKind: TopicKind;
  highStakes: HighStakesNotice | null;
};

const stageCopy: Record<string, { label: string; detail: string }> = {
  queued: {
    label: "Debate queued",
    detail: "The subject was accepted and the Hybrid Council run was initialized."
  },
  framing: {
    label: "Resolution framed",
    detail: "The free-text subject was converted into a neutral debate resolution."
  },
  researching: {
    label: "Evidence gathered",
    detail: "Sources were collected, deduplicated, and attached to claim-level arguments."
  },
  debating: {
    label: "Agents debated",
    detail: "Pro and con agents completed opening, cross-examination, rebuttal, and closing rounds."
  },
  judging: {
    label: "Judge synthesized",
    detail: "The neutral judge scored tradeoffs and prepared the decision brief."
  },
  complete: {
    label: "Debate complete",
    detail: "The decision brief, argument map, source ledger, and transcript are ready."
  }
};

export function frameDebateRequest(request: DebateRequest): FramedDebate {
  const topicKind = classifyTopic(request.subject, request.context);

  return {
    subject: request.subject.trim(),
    context: request.context?.trim() || undefined,
    resolution: frameResolution(request.subject, topicKind),
    topicKind,
    highStakes: detectHighStakes(request.subject, request.context)
  };
}

export type DebateEventEmitter = (event: DebateLiveEvent) => void;

export interface DebateExecutionOptions {
  provider?: LlmProvider;
  config?: DebateRuntimeConfig;
  emit?: DebateEventEmitter;
}

export async function runHybridCouncilDebate(
  debateId: string,
  request: DebateRequest,
  framed = frameDebateRequest(request),
  options: DebateExecutionOptions = {}
): Promise<DebateRun> {
  return new DebateWorkflowExecutor(options).run(debateId, request, framed);
}

class DebateWorkflowExecutor {
  private readonly config: DebateRuntimeConfig;
  private readonly provider: LlmProvider;
  private readonly emit: DebateEventEmitter;

  constructor(options: DebateExecutionOptions = {}) {
    this.config = options.config ?? loadDebateRuntimeConfig();
    this.provider = options.provider ?? createDefaultLlmProvider(this.config);
    this.emit = options.emit ?? (() => {});
  }

  async run(debateId: string, request: DebateRequest, framed: FramedDebate): Promise<DebateRun> {
    const runId = makeId("run");
    const startedAt = now();
    const events: DebateEvent[] = [];
    const trace: RunTraceEntry[] = [];
    const snapshots: ModelSnapshot[] = [];

    const recordSnapshot = (snapshot: ModelSnapshot) => {
      snapshots.push(snapshot);
      this.emit({ kind: "model_snapshot", snapshot });
    };

    pushEvent(events, debateId, runId, "queued");
    this.emit({ kind: "stage", status: "queued" });
    await runStep(trace, "frame", async () => {
      return `Classified as ${framed.topicKind}.`;
    });
    this.emit({
      kind: "framed",
      resolution: framed.resolution,
      topicKind: framed.topicKind,
      highStakes: framed.highStakes
    });

    pushEvent(events, debateId, runId, "framing");
    this.emit({ kind: "stage", status: "framing" });
    let scoutsPlaceholder: PlaceholderInfo | null = null;
    const scoutResult = await runStep(trace, "scout", async () => {
      const fallback = { scouts: buildStanceScouts(framed, this.config) };
      const { data, snapshot, placeholder } = await generateStructured(
        this.provider,
        "stance scout",
        "scoutOutput",
        fallback,
        scoutOutputSchema
      );
      recordSnapshot(snapshot);
      scoutsPlaceholder = placeholder;
      return {
        message: `${data.scouts.length} stance scouts generated independent lenses.`,
        value: data.scouts.map((scout) => ({ ...scout, id: makeId("scout") }))
      };
    });
    const scouts = scoutResult;
    this.emit({ kind: "scouts", scouts, ...(scoutsPlaceholder ? { placeholder: scoutsPlaceholder } : {}) });

    const teams = await runStep(trace, "team_builder", async () => {
      return {
        message: "Selected two pro and two con agents plus a neutral judge.",
        value: buildDebateTeams(scouts)
      };
    });
    this.emit({ kind: "teams", teams });

    pushEvent(events, debateId, runId, "researching");
    this.emit({ kind: "stage", status: "researching" });
    const sources = await runStep(trace, "evidence", async () => {
      const collected = await collectEvidence(framed.subject, framed.topicKind, this.config.evidenceProvider);
      const live = collected.some((source) => source.retrievedVia === "brave");
      return {
        status: live ? "ok" : "warning",
        message: live
          ? "Live Brave Search evidence was attached."
          : "Using deterministic development evidence because no live search provider returned sources.",
        value: collected
      };
    });
    this.emit({ kind: "sources", sources });

    let claimsPlaceholder: PlaceholderInfo | null = null;
    const claimOutput = await runStep(trace, "opening", async () => {
      const fallback = { claims: buildClaims(framed, sources).map(({ id: _id, ...claim }) => claim) };
      const { data, snapshot, placeholder } = await generateStructured(
        this.provider,
        "claim builder",
        "claimOutput",
        fallback,
        claimOutputSchema
      );
      recordSnapshot(snapshot);
      claimsPlaceholder = placeholder;
      return {
        message: `${data.claims.length} source-linked claims generated.`,
        value: data.claims.map((claim) => ({ ...claim, id: makeId("claim") }))
      };
    });
    const claims = claimOutput;
    this.emit({ kind: "claims", claims, ...(claimsPlaceholder ? { placeholder: claimsPlaceholder } : {}) });
    const { nodes, edges } = buildArgumentMap(framed, claims, sources);
    this.emit({ kind: "argument_map", nodes, edges });

    pushEvent(events, debateId, runId, "debating");
    this.emit({ kind: "stage", status: "debating" });

    // Generate turns one round at a time so they stream to the client as they
    // arrive instead of landing as a single dump at the end of the debating
    // phase. Each round is its own LLM call with role-derived model routing.
    const allFallbackTurns = buildRoundTurns(teams, claims, sources, framed, this.config.maxRounds);
    const roundOrder: RoundTurn["round"][] = [
      "opening",
      "cross_examination",
      "rebuttal",
      "closing",
      "judge_review"
    ];
    const presentRounds = roundOrder.filter((round) =>
      allFallbackTurns.some((turn) => turn.round === round)
    );

    const openingTurns: RoundTurn[] = [];
    for (const round of presentRounds) {
      const roundFallback = allFallbackTurns.filter((turn) => turn.round === round);
      if (roundFallback.length === 0) continue;

      let roundPlaceholder: PlaceholderInfo | null = null;
      const turnsForRound = await runStep(trace, traceStepForRound(round), async () => {
        const { data, snapshot, placeholder } = await generateStructured(
          this.provider,
          roleForRound(round),
          "debateTurnOutput",
          { turns: roundFallback.map(({ id: _id, createdAt: _createdAt, ...turn }) => turn) },
          debateTurnOutputSchema
        );
        recordSnapshot(snapshot);
        roundPlaceholder = placeholder;
        return {
          message: `${data.turns.length} turns generated for ${round.replace("_", " ")}.`,
          value: data.turns.map((turn) => ({ ...turn, id: makeId("turn"), createdAt: now() }))
        };
      });

      openingTurns.push(...turnsForRound);
      this.emit({
        kind: "turns",
        round,
        turns: turnsForRound,
        ...(roundPlaceholder ? { placeholder: roundPlaceholder } : {})
      });
    }

    pushEvent(events, debateId, runId, "judging");
    this.emit({ kind: "stage", status: "judging" });
    let scorecardPlaceholder: PlaceholderInfo | null = null;
    const scorecard = await runStep(trace, "rebuttal", async () => {
      const fallback = buildScorecard(claims, framed.topicKind);
      const { data, snapshot, placeholder } = await generateStructured(
        this.provider,
        "scorecard judge",
        "judgeScorecardOutput",
        fallback,
        judgeScorecardOutputSchema
      );
      recordSnapshot(snapshot);
      scorecardPlaceholder = placeholder;
      return {
        message: `Judge scored the debate as ${data.recommendation}.`,
        value: data
      };
    });
    this.emit({
      kind: "scorecard",
      scorecard,
      ...(scorecardPlaceholder ? { placeholder: scorecardPlaceholder } : {})
    });
    let summaryPlaceholder: PlaceholderInfo | null = null;
    const summary = await runStep(trace, "judge", async () => {
      const fallback = buildSummary(framed, claims, scorecard);
      const { data, snapshot, placeholder } = await generateStructured(
        this.provider,
        "final summary",
        "finalSummaryOutput",
        fallback,
        finalSummaryOutputSchema
      );
      recordSnapshot(snapshot);
      summaryPlaceholder = placeholder;
      return {
        message: `Recommendation: ${scorecard.recommendation}.`,
        value: data
      };
    });
    this.emit({
      kind: "summary",
      summary,
      ...(summaryPlaceholder ? { placeholder: summaryPlaceholder } : {})
    });

    pushEvent(events, debateId, runId, "complete");
    this.emit({ kind: "stage", status: "complete" });
    this.emit({ kind: "complete", runId });
    const modelSnapshots = mergeModelSnapshots(modelRosterFromConfig(this.config), snapshots);
    const artifactManifest = buildArtifactManifest({
      scouts,
      sources,
      claims,
      turns: openingTurns,
      scorecard,
      summary,
      modelSnapshots
    });
    await runStep(trace, "persist", async () => "Run assembled with stable artifact manifest for repository persistence.");

    return {
      id: runId,
      debateId,
      status: "complete",
      startedAt,
      completedAt: now(),
      events,
      scouts,
      teams,
      sources,
      claims,
      argumentNodes: nodes,
      argumentEdges: edges,
      turns: openingTurns,
      scorecard,
      summary,
      modelSnapshots,
      artifactManifest,
      trace
    };
  }
}

type StepResult<T> =
  | string
  | {
      message: string;
      status?: RunTraceEntry["status"];
      value: T;
    };

async function runStep<T>(
  trace: RunTraceEntry[],
  step: RunTraceEntry["step"],
  execute: () => Promise<StepResult<T>> | StepResult<T>
): Promise<T> {
  const started = Date.now();

  try {
    const result = await execute();
    const durationMs = Date.now() - started;

    if (typeof result === "string") {
      trace.push(traceEntry(step, "ok", result, durationMs));
      return undefined as T;
    }

    trace.push(traceEntry(step, result.status ?? "ok", result.message, durationMs));
    return result.value;
  } catch (error) {
    trace.push(
      traceEntry(step, "failed", error instanceof Error ? error.message : "Workflow step failed.", Date.now() - started)
    );
    throw error;
  }
}

async function generateStructured<TSchema extends z.ZodTypeAny>(
  provider: LlmProvider,
  role: string,
  schemaName: string,
  fallback: z.infer<TSchema>,
  schema: TSchema
): Promise<{
  data: z.infer<TSchema>;
  snapshot: ModelSnapshot;
  placeholder: PlaceholderInfo | null;
}> {
  const fallbackParse = schema.safeParse(fallback);
  if (!fallbackParse.success) {
    throw new Error(`Invalid deterministic fallback for ${schemaName}: ${fallbackParse.error.message}`);
  }

  const requestedModel = provider.modelForRole(role);

  try {
    const result = await provider.generateStructured<unknown>({
      role,
      schemaName,
      prompt: JSON.stringify(fallbackParse.data),
      jsonSchema: z.toJSONSchema(schema)
    });
    const parsed = schema.safeParse(result.data);

    if (!parsed.success) {
      const reason = `Structured output validation failed: ${parsed.error.message}`;
      return {
        data: fallbackParse.data,
        snapshot: {
          ...result.snapshot,
          failure: reason
        },
        placeholder: { requestedModel: result.snapshot.model || requestedModel, reason }
      };
    }

    return {
      data: parsed.data,
      snapshot: result.snapshot,
      placeholder: null
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Structured generation failed.";
    return {
      data: fallbackParse.data,
      snapshot: {
        id: `fallback-${schemaName}`,
        provider: "local",
        model: requestedModel,
        role,
        configured: true,
        failure: reason
      },
      placeholder: { requestedModel, reason }
    };
  }
}

function mergeModelSnapshots(roster: ModelSnapshot[], generated: ModelSnapshot[]): ModelSnapshot[] {
  const snapshots = new Map<string, ModelSnapshot>();

  for (const snapshot of [...roster, ...generated]) {
    snapshots.set(snapshot.id, snapshot);
  }

  return Array.from(snapshots.values());
}

function buildArtifactManifest(input: {
  scouts: StanceScout[];
  sources: EvidenceSource[];
  claims: Claim[];
  turns: RoundTurn[];
  scorecard: Scorecard;
  summary: DebateRun["summary"];
  modelSnapshots: ModelSnapshot[];
}): RunArtifact[] {
  const createdAt = now();

  return [
    { id: makeId("artifact"), kind: "run_state", label: "Workflow run state", recordCount: 1, createdAt },
    { id: makeId("artifact"), kind: "scouts", label: "Structured scout outputs", recordCount: input.scouts.length, createdAt },
    { id: makeId("artifact"), kind: "evidence", label: "Evidence source ledger", recordCount: input.sources.length, createdAt },
    { id: makeId("artifact"), kind: "claims", label: "Generated claims", recordCount: input.claims.length, createdAt },
    { id: makeId("artifact"), kind: "turns", label: "Debate transcript turns", recordCount: input.turns.length, createdAt },
    { id: makeId("artifact"), kind: "scorecard", label: "Judge scorecard", recordCount: input.scorecard.categories.length, createdAt },
    { id: makeId("artifact"), kind: "summary", label: "Final summary", recordCount: 1, createdAt },
    { id: makeId("artifact"), kind: "models", label: "Model snapshots", recordCount: input.modelSnapshots.length, createdAt }
  ];
}

export function productNotes(): ProductNote[] {
  return [
    {
      id: "note-debate-showcase",
      title: "Debate Showcase",
      mode: "debate_showcase",
      note:
        "Future mode for highly polished, shareable debates with stronger character voice, pacing, and presentation quality.",
      priority: "candidate"
    },
    {
      id: "note-model-lab",
      title: "Model Lab",
      mode: "model_lab",
      note:
        "Future mode for comparing model/operator performance by topic, citation quality, latency, cost, and judge preference.",
      priority: "research"
    }
  ];
}

function buildStanceScouts(framed: FramedDebate, config: DebateRuntimeConfig): StanceScout[] {
  const base = [
    {
      name: "Strategic Optimist",
      model: config.quickModel,
      lens: "upside, option value, and second-order gains",
      side: "pro" as const
    },
    {
      name: "Risk Skeptic",
      model: config.deepModel,
      lens: "failure modes, hidden costs, and reversibility",
      side: "con" as const
    },
    {
      name: "Empirical Referee",
      model: config.judgeModel,
      lens: "quality of evidence, base rates, and uncertainty",
      side: "neutral" as const
    },
    {
      name: "Implementation Pragmatist",
      model: config.quickModel,
      lens: "execution design, sequencing, and measurable checkpoints",
      side: "pro" as const
    },
    {
      name: "Equity Auditor",
      model: config.deepModel,
      lens: "distributional impact, incentives, and affected stakeholders",
      side: "con" as const
    }
  ];

  return base.map((scout, index) => ({
    id: makeId("scout"),
    ...scout,
    thesis: buildScoutThesis(scout.side, scout.lens, framed),
    assumptions: [
      `The debate is treated as a ${framed.topicKind} question.`,
      "The final answer should surface tradeoffs rather than pretend the issue is settled.",
      scout.side === "neutral"
        ? "Evidence quality matters more than rhetorical force."
        : `The ${scout.side} side should present the strongest good-faith version of its case.`
    ],
    strongestArguments:
      scout.side === "con"
        ? [
            "The costs and implementation risks may arrive before benefits are measurable.",
            "Stakeholders with less power may carry more downside than the headline summary implies.",
            "A reversible pilot may be safer than a broad commitment."
          ]
        : scout.side === "pro"
          ? [
              "The resolution may create meaningful upside if implemented with constraints and measurement.",
              "A staged approach can preserve learning while limiting irreversible exposure.",
              "The alternative may have its own unpriced risks."
            ]
          : [
              "The decision turns on evidence quality, context fit, and reversibility.",
              "Both sides need source-backed claims and explicit uncertainty.",
              "The synthesis should say what evidence would change the recommendation."
            ],
    model: `${scout.model}${index === 2 ? " (judge-calibrated)" : ""}`
  }));
}

function buildScoutThesis(side: "pro" | "con" | "neutral", lens: string, framed: FramedDebate): string {
  if (side === "pro") {
    return `From a ${lens} lens, ${framed.resolution} is plausible if adopted with measurable guardrails.`;
  }

  if (side === "con") {
    return `From a ${lens} lens, ${framed.resolution} may fail unless risks are narrowed before commitment.`;
  }

  return `From a ${lens} lens, the right answer depends on evidence strength, context, and reversibility.`;
}

function buildDebateTeams(scouts: StanceScout[]): DebateTeam {
  const toAgent = (scout: StanceScout, role: string, side: "pro" | "con"): DebateAgent => ({
    id: makeId("agent"),
    name: scout.name,
    side,
    model: scout.model,
    role,
    thesis: scout.thesis
  });

  const proScouts = scouts.filter((scout) => scout.side === "pro");
  const conScouts = scouts.filter((scout) => scout.side === "con");
  const neutralScouts = scouts.filter((scout) => scout.side === "neutral");
  const anyScout = scouts[0];

  if (!anyScout) {
    throw new Error("Cannot build debate teams: no stance scouts were produced.");
  }

  const pickPro = (index: number): StanceScout =>
    proScouts[index] ?? proScouts[0] ?? neutralScouts[index] ?? neutralScouts[0] ?? anyScout;
  const pickCon = (index: number): StanceScout =>
    conScouts[index] ?? conScouts[0] ?? neutralScouts[index] ?? neutralScouts[0] ?? anyScout;
  const judgeScout = neutralScouts[0] ?? anyScout;

  return {
    pro: [toAgent(pickPro(0), "opening case", "pro"), toAgent(pickPro(1), "implementation rebuttal", "pro")],
    con: [toAgent(pickCon(0), "risk case", "con"), toAgent(pickCon(1), "stakeholder rebuttal", "con")],
    judge: {
      id: makeId("judge"),
      name: "Neutral Synthesis Judge",
      model: judgeScout.model,
      role: "score evidence, risks, uncertainty, and decision usefulness"
    }
  };
}

function buildClaims(framed: FramedDebate, sources: EvidenceSource[]): Claim[] {
  const sourceIds = sources.length > 0 ? sources.map((source) => source.id) : ["src-unavailable"];
  const pick = (index: number) => [sourceIds[index % sourceIds.length]];
  const proposal = framed.subject.replace(/[.?!]+$/, "");

  return [
    {
      id: makeId("claim"),
      side: "pro",
      text: `The proposal, "${proposal}", could create meaningful upside if the rollout is incremental and measurable.`,
      warrant: "A staged approach lets decision-makers capture learning while preserving the option to stop or revise.",
      evidenceSourceIds: pick(0),
      confidence: 0.72
    },
    {
      id: makeId("claim"),
      side: "pro",
      text: "The strongest pro case is not inevitability; it is disciplined experimentation with clear success metrics.",
      warrant: "Decision quality improves when the pro side defines observable outcomes and time-boxed review points.",
      evidenceSourceIds: pick(1),
      confidence: 0.68
    },
    {
      id: makeId("claim"),
      side: "pro",
      text: "Doing nothing may also carry opportunity cost, status-quo bias, and unmanaged externalities.",
      warrant: "A fair comparison should evaluate the current path, not only the proposed change.",
      evidenceSourceIds: pick(2),
      confidence: 0.64
    },
    {
      id: makeId("claim"),
      side: "con",
      text: `The proposal, "${proposal}", could produce hidden costs that are hard to reverse after incentives and infrastructure adapt.`,
      warrant: "The con case is strongest when adoption creates lock-in, stakeholder burden, or misleading early wins.",
      evidenceSourceIds: pick(3),
      confidence: 0.7
    },
    {
      id: makeId("claim"),
      side: "con",
      text: "The evidence may not transfer cleanly to the user's context, especially if incentives or constraints differ.",
      warrant: "General studies and broad analogies can overstate confidence when local conditions dominate outcomes.",
      evidenceSourceIds: pick(4),
      confidence: 0.66
    },
    {
      id: makeId("claim"),
      side: "con",
      text: "A binary yes/no framing may obscure safer alternatives such as pilots, thresholds, or narrower scope.",
      warrant: "Many contested decisions become better when reframed as sequencing and risk-budget questions.",
      evidenceSourceIds: pick(5),
      confidence: 0.74
    }
  ];
}

function buildArgumentMap(
  framed: FramedDebate,
  claims: Claim[],
  sources: EvidenceSource[]
): { nodes: ArgumentNode[]; edges: ArgumentEdge[] } {
  const rootId = "resolution";
  const nodes: ArgumentNode[] = [
    {
      id: rootId,
      kind: "resolution",
      side: "neutral",
      label: framed.resolution,
      detail: `Classified as a ${framed.topicKind} debate.`
    }
  ];

  const edges: ArgumentEdge[] = [];

  for (const claim of claims) {
    nodes.push({
      id: claim.id,
      kind: "claim",
      side: claim.side,
      label: claim.side === "pro" ? "Pro claim" : "Con claim",
      detail: claim.text
    });
    edges.push({
      id: makeId("edge"),
      source: claim.id,
      target: rootId,
      relation: claim.side === "pro" ? "supports" : "challenges"
    });
  }

  for (const source of sources.slice(0, 6)) {
    const nodeId = `evidence-${source.id}`;
    nodes.push({
      id: nodeId,
      kind: "evidence",
      side: "neutral",
      label: source.publisher,
      detail: source.title,
      sourceId: source.id
    });

    const targetClaim = claims.find((claim) => claim.evidenceSourceIds.includes(source.id));
    if (targetClaim) {
      edges.push({
        id: makeId("edge"),
        source: nodeId,
        target: targetClaim.id,
        relation: "supports"
      });
    }
  }

  nodes.push({
    id: "uncertainty",
    kind: "uncertainty",
    side: "neutral",
    label: "Main uncertainty",
    detail: "Would the evidence and incentives still hold in this user's exact context?"
  });
  edges.push({
    id: makeId("edge"),
    source: "uncertainty",
    target: rootId,
    relation: "qualifies"
  });

  return { nodes, edges };
}

function buildRoundTurns(
  teams: DebateTeam,
  claims: Claim[],
  sources: EvidenceSource[],
  framed: FramedDebate,
  maxRounds = 3
): RoundTurn[] {
  const proClaims = claims.filter((claim) => claim.side === "pro");
  const conClaims = claims.filter((claim) => claim.side === "con");
  const sourceIds = sources.slice(0, 4).map((source) => source.id);
  const claimIdsAt = (list: Claim[], ...indexes: number[]): string[] =>
    indexes
      .map((index) => list[index])
      .filter((claim): claim is Claim => Boolean(claim))
      .map((claim) => claim.id);
  const turn = (
    round: RoundTurn["round"],
    agent: DebateAgent | DebateTeam["judge"],
    side: RoundTurn["side"],
    content: string,
    claimIds: string[]
  ): RoundTurn => ({
    id: makeId("turn"),
    round,
    agentId: agent.id,
    agentName: agent.name,
    side,
    content,
    claimIds,
    sourceIds,
    createdAt: now()
  });

  const turns = [
    turn(
      "opening",
      teams.pro[0],
      "pro",
      `${teams.pro[0].name}: The affirmative case for "${framed.resolution}" rests on disciplined experimentation. The upside is real only if success metrics, review dates, and rollback paths are named before action.`,
      proClaims.slice(0, 2).map((claim) => claim.id)
    ),
    turn(
      "opening",
      teams.con[0],
      "con",
      `${teams.con[0].name}: The negative case is that a persuasive idea can still fail through lock-in, weak evidence transfer, and hidden stakeholder costs. The burden is on the pro side to show reversibility.`,
      conClaims.slice(0, 2).map((claim) => claim.id)
    ),
    turn(
      "cross_examination",
      teams.pro[1],
      "pro",
      `${teams.pro[1].name}: The con side should identify which risk would justify inaction rather than a limited pilot. If the concern is context fit, a measured trial may answer that question faster than delay.`,
      claimIdsAt(proClaims, 1).concat(claimIdsAt(conClaims, 1))
    ),
    turn(
      "cross_examination",
      teams.con[1],
      "con",
      `${teams.con[1].name}: The pro side should explain who bears downside during the trial and what threshold stops expansion. A pilot without a stop rule can become adoption by default.`,
      claimIdsAt(conClaims, 2).concat(claimIdsAt(proClaims, 0))
    ),
    turn(
      "rebuttal",
      teams.pro[0],
      "pro",
      `${teams.pro[0].name}: The negative side is right about lock-in, but that argues for explicit constraints rather than rejecting the resolution outright. The current state also has costs that deserve measurement.`,
      proClaims.map((claim) => claim.id)
    ),
    turn(
      "rebuttal",
      teams.con[0],
      "con",
      `${teams.con[0].name}: The affirmative case improves once it becomes conditional, but that concession matters. The plain resolution should not be accepted without local evidence and accountability.`,
      conClaims.map((claim) => claim.id)
    ),
    turn(
      "closing",
      teams.pro[1],
      "pro",
      `${teams.pro[1].name}: Vote pro only in the narrower sense: proceed with a reversible, evidence-gathering implementation rather than a broad irreversible commitment.`,
      proClaims.map((claim) => claim.id)
    ),
    turn(
      "closing",
      teams.con[1],
      "con",
      `${teams.con[1].name}: Vote con against overconfidence. The best path may be a smaller test, not full adoption of the resolution as stated.`,
      conClaims.map((claim) => claim.id)
    ),
    turn(
      "judge_review",
      teams.judge,
      "neutral",
      `${teams.judge.name}: Both sides converge on conditionality. The pro side wins on option value; the con side wins on governance and burden of proof.`,
      claims.map((claim) => claim.id)
    )
  ];

  const roundOrder: RoundTurn["round"][] = ["opening", "cross_examination", "rebuttal", "closing"];
  const activeRounds = new Set(roundOrder.slice(0, Math.min(maxRounds, roundOrder.length)));

  return turns.filter((item) => item.round === "judge_review" || activeRounds.has(item.round));
}

function buildScorecard(claims: Claim[], topicKind: TopicKind): Scorecard {
  const proConfidence = average(claims.filter((claim) => claim.side === "pro").map((claim) => claim.confidence));
  const conConfidence = average(claims.filter((claim) => claim.side === "con").map((claim) => claim.confidence));
  const topicAdjustment = topicKind === "decision" || topicKind === "comparison" ? 0.2 : 0;
  const proBase = Math.round((proConfidence * 10 + topicAdjustment) * 10) / 10;
  const conBase = Math.round(conConfidence * 10 * 10) / 10;
  const spread = proBase - conBase;

  return {
    recommendation: spread > 0.9 ? "lean_yes" : spread < -0.9 ? "lean_no" : "conditional_yes",
    confidence: Math.min(0.82, Math.max(0.52, 0.62 + Math.abs(spread) / 20)),
    categories: [
      {
        name: "evidence",
        pro: proBase,
        con: conBase,
        note: "Both sides have plausible evidence, but source transfer to the exact context remains a constraint."
      },
      {
        name: "practicality",
        pro: Math.min(10, proBase + 0.7),
        con: Math.max(1, conBase - 0.2),
        note: "The pro case strengthens if implementation can be staged and measured."
      },
      {
        name: "risk",
        pro: Math.max(1, proBase - 0.8),
        con: Math.min(10, conBase + 0.8),
        note: "The con case is strongest around hidden costs, lock-in, and affected stakeholders."
      },
      {
        name: "fairness",
        pro: Math.max(1, proBase - 0.2),
        con: Math.min(10, conBase + 0.3),
        note: "Distributional impact should be reviewed before scaling."
      },
      {
        name: "reversibility",
        pro: Math.min(10, proBase + 0.5),
        con: Math.max(1, conBase - 0.4),
        note: "A pilot, threshold, or sunset clause improves the recommendation."
      }
    ]
  };
}

function buildSummary(framed: FramedDebate, claims: Claim[], scorecard: Scorecard) {
  const proClaims = claims.filter((claim) => claim.side === "pro");
  const conClaims = claims.filter((claim) => claim.side === "con");
  const confidence = scorecard.confidence;
  const highStakesDisclaimer = framed.highStakes?.message;

  return {
    headline: "Proceed conditionally, with explicit evidence thresholds and rollback rules.",
    recommendation: `The verdict is a conditional yes rather than a blank-check approval. The strongest path is a staged decision: define the success metrics, limit the first commitment, and name the evidence that would stop or expand the plan.`,
    strongestPro: proClaims.map((claim) => claim.text),
    strongestCon: conClaims.map((claim) => claim.text),
    unresolvedUncertainties: [
      "Whether cited evidence transfers to the user's actual constraints and incentives.",
      "Who bears downside during the first implementation phase.",
      "Which measurable threshold would justify scaling, pausing, or reversing the decision."
    ],
    whatWouldChangeMind: [
      "High-quality evidence showing poor outcomes in closely comparable contexts.",
      "A credible implementation design with enforceable rollback triggers and stakeholder protections.",
      "New cost, safety, or legal constraints that materially change the risk budget."
    ],
    confidence,
    highStakesDisclaimer
  };
}

function pushEvent(
  events: DebateEvent[],
  debateId: string,
  runId: string,
  status: DebateEvent["status"]
): void {
  const copy = stageCopy[status] ?? {
    label: status,
    detail: "Debate stage updated."
  };

  events.push({
    id: makeId("event"),
    debateId,
    runId,
    status,
    label: copy.label,
    detail: copy.detail,
    createdAt: now()
  });
}

function traceEntry(
  step: RunTraceEntry["step"],
  status: RunTraceEntry["status"],
  message: string,
  durationMs?: number
): RunTraceEntry {
  return {
    id: makeId("trace"),
    step,
    status,
    message,
    at: now(),
    durationMs
  };
}

function traceStepForRound(round: RoundTurn["round"]): RunTraceEntry["step"] {
  switch (round) {
    case "opening":
      return "opening";
    case "cross_examination":
      return "cross_exam";
    case "rebuttal":
      return "rebuttal";
    case "closing":
      return "closing";
    case "judge_review":
      return "judge_review";
    case "synthesis":
    default:
      return "judge";
  }
}

function roleForRound(round: RoundTurn["round"]): string {
  // The role string is matched against model routing keywords in
  // LlmProvider.modelForRole(): "judge" / "summary" / "scorecard" => judge slot,
  // "claim" / "rebuttal" => deep slot, otherwise => quick slot.
  switch (round) {
    case "opening":
      return "opening round";
    case "cross_examination":
      return "cross-examination round";
    case "rebuttal":
      return "rebuttal round";
    case "closing":
      return "closing round";
    case "judge_review":
      return "judge review round";
    case "synthesis":
    default:
      return "synthesis round";
  }
}

function makeId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

function now(): string {
  return new Date().toISOString();
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
