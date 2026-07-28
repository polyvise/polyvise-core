import { randomUUID } from "node:crypto";
import { collectEvidenceWithDiagnostics } from "../providers/search";
import {
  createDefaultLlmProvider,
  LlmProviderFailure,
  type LlmProvider
} from "../providers/llm";
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
  CouncilSize,
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
  RunPlaceholders,
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
type GeneratedRoundTurn = Omit<RoundTurn, "id" | "createdAt">;

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
  const config = options.config ?? configForRequest(loadDebateRuntimeConfig(), request);
  return new DebateWorkflowExecutor({ ...options, config }).run(debateId, request, framed);
}

function configForRequest(config: DebateRuntimeConfig, request: DebateRequest): DebateRuntimeConfig {
  return {
    ...config,
    quickModel: request.models?.quick?.trim() || config.quickModel,
    deepModel: request.models?.deep?.trim() || config.deepModel,
    yesModel: request.models?.yes?.trim() || request.models?.quick?.trim() || config.yesModel,
    noModel: request.models?.no?.trim() || request.models?.deep?.trim() || config.noModel,
    judgeModel: request.models?.judge?.trim() || config.judgeModel
  };
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
    // Mirrors the per-step `placeholder` on the event stream so a consumer
    // reading the stored run can tell filler from model output.
    const placeholders: RunPlaceholders = {};
    // "quartet" is the legacy shape (2 pro + 2 con). "duo" is the simpler
    // 1-on-1 shape used by the /froglings funner experience.
    const councilSize: CouncilSize = request.councilSize ?? "quartet";

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
      if (councilSize === "duo") {
        return {
          message: "Used deterministic duo scouts to avoid a startup LLM call.",
          value: fallback.scouts
        };
      }

      const { data, snapshot, placeholder } = await generateStructured(
        this.provider,
        "stance scout",
        "scoutOutput",
        fallback,
        scoutOutputSchema,
        this.config,
        buildGenerationPrompt({
          task: "Create five debate agents with distinct lenses for this exact resolution.",
          framed,
          fallback
        }),
        runId
      );
      recordSnapshot(snapshot);
      scoutsPlaceholder = placeholder;
      return {
        message: `${data.scouts.length} stance scouts generated independent lenses.`,
        value: data.scouts.map((scout) => ({ ...scout, id: makeId("scout") }))
      };
    });
    const scouts = scoutResult;
    if (scoutsPlaceholder) placeholders.scouts = scoutsPlaceholder;
    this.emit({ kind: "scouts", scouts, ...(scoutsPlaceholder ? { placeholder: scoutsPlaceholder } : {}) });

    const teams = await runStep(trace, "team_builder", async () => {
      const built = buildDebateTeams(scouts, councilSize);
      return {
        message:
          councilSize === "duo"
            ? "Selected one pro and one con agent plus a neutral judge."
            : "Selected two pro and two con agents plus a neutral judge.",
        value: built
      };
    });
    this.emit({ kind: "teams", teams });

    pushEvent(events, debateId, runId, "researching");
    this.emit({ kind: "stage", status: "researching" });
    const sources = await runStep(trace, "evidence", async () => {
      const { sources: collected, diagnostic } = await collectEvidenceWithDiagnostics(
        framed.subject,
        framed.topicKind,
        this.config
      );
      const liveProvider = collected.find((source) => source.retrievedVia !== "mock")?.retrievedVia;
      return {
        status: liveProvider ? "ok" : "warning",
        message: liveProvider
          ? `Live ${liveProvider} search evidence was attached.`
          : `Using deterministic development evidence. ${diagnostic ?? "No live search provider returned sources."}`,
        value: collected
      };
    });
    this.emit({ kind: "sources", sources });

    let claimsPlaceholder: PlaceholderInfo | null = null;
    const claimOutput = await runStep(trace, "opening", async () => {
      const fallback = { claims: buildClaims(framed, sources).map(({ id: _id, ...claim }) => claim) };
      const generatedClaims = [];

      const claimBatches =
        councilSize === "duo"
          ? [
              { side: "pro" as const, role: "yes frog claim builder" },
              { side: "con" as const, role: "no frog claim builder" }
            ]
          : [{ side: null, role: "claim builder" }];

      for (const batch of claimBatches) {
        const batchFallback =
          batch.side === null
            ? fallback
            : { claims: fallback.claims.filter((claim) => claim.side === batch.side) };
        const { data, snapshot, placeholder } = await generateStructured(
          this.provider,
          batch.role,
          "claimOutput",
          batchFallback,
          claimOutputSchema,
          this.config,
          buildGenerationPrompt({
            task:
              batch.side === "pro"
                ? "Create topic-specific YES-side claims. Use the cited source ids where relevant. Do not write NO-side claims."
                : batch.side === "con"
                  ? "Create topic-specific NO-side claims. Use the cited source ids where relevant. Do not write YES-side claims."
                  : "Create topic-specific pro and con claims. Use the cited source ids where relevant. Do not copy generic pilot, rollback, or implementation language unless the resolution itself is about implementation.",
            framed,
            sources,
            fallback: batchFallback
          }),
          runId
        );
        recordSnapshot(snapshot);
        claimsPlaceholder = claimsPlaceholder ?? placeholder;
        generatedClaims.push(...data.claims);
      }

      return {
        message: `${generatedClaims.length} source-linked claims generated.`,
        value: generatedClaims.map((claim) => ({ ...claim, id: makeId("claim") }))
      };
    });
    const claims = claimOutput;
    if (claimsPlaceholder) placeholders.claims = claimsPlaceholder;
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
        const generatedTurns = [];
        const turnBatches =
          councilSize === "duo" && round !== "judge_review"
            ? [
                {
                  role: `yes frog ${roleForRound(round)}`,
                  turns: roundFallback.filter((turn) => turn.side === "pro")
                },
                {
                  role: `no frog ${roleForRound(round)}`,
                  turns: roundFallback.filter((turn) => turn.side === "con")
                }
              ]
            : [{ role: roleForRound(round), turns: roundFallback }];

        for (const batch of turnBatches) {
          if (batch.turns.length === 0) continue;
          const batchFallback = {
            turns: batch.turns.map(({ id: _id, createdAt: _createdAt, ...turn }) => turn)
          };
          const { data, snapshot, placeholder } = await generateStructured(
            this.provider,
            batch.role,
            "debateTurnOutput",
            batchFallback,
            debateTurnOutputSchema,
            this.config,
            buildGenerationPrompt({
              task: turnGenerationTask(councilSize, batch.turns),
              framed,
              sources,
              claims,
              teams,
              round,
              turns: openingTurns,
              expectedTurns: batch.turns,
              fallback: batchFallback
            }),
            runId
          );
          recordSnapshot(snapshot);
          roundPlaceholder = roundPlaceholder ?? placeholder;
          const batchTurns = reconcileGeneratedTurns(data.turns, batch.turns, this.config);
          // Only name a model on turns a model actually wrote. A fallback batch
          // has a requested model, but it didn't produce this text.
          generatedTurns.push(
            ...(placeholder ? batchTurns : batchTurns.map((turn) => ({ ...turn, model: snapshot.model })))
          );
        }

        return {
          message: `${generatedTurns.length} turns generated for ${round.replace("_", " ")}.`,
          value: generatedTurns.map((turn) => ({
            ...turn,
            content: polishDebateTurnContent(turn.content, turn),
            id: makeId("turn"),
            createdAt: now()
          }))
        };
      });

      openingTurns.push(...turnsForRound);
      if (roundPlaceholder) {
        placeholders.turns = { ...placeholders.turns, [round]: roundPlaceholder };
      }
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
      const fallback = buildScorecard(claims, framed);
      const { data, snapshot, placeholder } = await generateStructured(
        this.provider,
        "scorecard judge",
        "judgeScorecardOutput",
        fallback,
        judgeScorecardOutputSchema,
        this.config,
        buildGenerationPrompt({
          task:
            "Score the actual debate. NO is a fully valid winning answer. Do not reward YES by default. Choose lean_yes, conditional_yes, conditional_no, or lean_no whenever one side is even modestly stronger; use mixed only for a genuine near tie or unusable evidence. Notes must mention the strongest point from each side, the hinge that decides the debate, and why the verdict follows from the transcript. For broad policies involving children, schools, voting, animals, health, safety, or legal accommodations, require the YES side to prove the policy is safe, fair, administrable, and meaningfully better than the status quo; benefits that merely sound nice should not outweigh concrete safety, hygiene, supervision, disruption, access, or legal risks. If the broad and narrow versions of the question have different answers, prefer a conditional verdict and name that scope difference in category notes. Confidence above 0.65 is only justified when the winning side directly answered the strongest opposing concern.",
          framed,
          sources,
          claims,
          teams,
          turns: openingTurns,
          fallback
        }),
        runId
      );
      recordSnapshot(snapshot);
      scorecardPlaceholder = placeholder;
      return {
        message: `Judge scored the debate as ${data.recommendation}.`,
        value: calibrateScorecardForPolicyBurden(data, framed, claims, openingTurns)
      };
    });
    if (scorecardPlaceholder) placeholders.scorecard = scorecardPlaceholder;
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
        finalSummaryOutputSchema,
        this.config,
        buildGenerationPrompt({
          task:
            "Write the final verdict for this exact resolution for a grades 5-8 reader. Be willing to say NO when the pink frog made the stronger case. Do not soften a NO result into uncertainty unless the scorecard is mixed. The headline and recommendation must name the debate hinge, the strongest point from each side, and the reason for the verdict in plain language. Headline: one complete sentence or headline phrase, around 90 characters or less; 120 is the hard maximum. Recommendation: 2 to 3 complete sentences, around 240 characters or less; 320 is the hard maximum. Never end mid-word, mid-clause, or with a dangling word like while, because, or and. If the copy is too long, rewrite it shorter instead of truncating it. If the broad and narrow versions of the question have different answers, say that directly instead of pretending there is one simple answer. Use green frog and pink frog language in visible copy, not pro side, con side, YES frog, or NO frog. For school, child, animal, safety, voting, legal, or accommodation policies, do not treat warm benefits as enough for YES unless the green frog addressed the concrete risks and implementation burdens.",
          framed,
          sources,
          claims,
          teams,
          turns: openingTurns,
          scorecard,
          fallback
        }),
        runId
      );
      recordSnapshot(snapshot);
      summaryPlaceholder = placeholder;
      return {
        message: `Recommendation: ${scorecard.recommendation}.`,
        value: normalizeSummary(data, scorecard.confidence)
      };
    });
    if (summaryPlaceholder) placeholders.summary = summaryPlaceholder;
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
      councilSize,
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
      trace,
      placeholders
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
  schema: TSchema,
  config: DebateRuntimeConfig,
  prompt?: string,
  sessionId?: string
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
  let lastReason = "Structured generation failed.";
  let lastSnapshot: ModelSnapshot | null = null;

  for (let attempt = 1; attempt <= config.llmMaxAttempts; attempt += 1) {
    try {
      const result = await provider.generateStructured<unknown>({
        role,
        schemaName,
        prompt: prompt ?? JSON.stringify(fallbackParse.data),
        fallback: fallbackParse.data,
        jsonSchema: z.toJSONSchema(schema),
        sessionId
      });
      const parsed = schema.safeParse(result.data);

      if (!parsed.success) {
        lastReason = `Structured output validation failed: ${parsed.error.message}`;
        lastSnapshot = {
          ...result.snapshot,
          failure: lastReason
        };
        if (attempt < config.llmMaxAttempts) continue;
        break;
      }

      return {
        data: parsed.data,
        snapshot: result.snapshot,
        placeholder: null
      };
    } catch (error) {
      lastReason = error instanceof Error ? error.message : "Structured generation failed.";
      if (error instanceof LlmProviderFailure) {
        lastSnapshot = error.snapshot;
      }
      if (!config.allowDeterministicFallbacks) {
        throw error;
      }
      break;
    }
  }

  if (!config.allowDeterministicFallbacks) {
    throw new Error(lastReason);
  }

  if (lastSnapshot) {
    return {
      data: fallbackParse.data,
      snapshot: lastSnapshot,
      placeholder: { requestedModel: lastSnapshot.model || requestedModel, reason: lastReason }
    };
  }

  return {
    data: fallbackParse.data,
    snapshot: {
      // Role, not just schema name: several steps share a schema (every turn
      // round uses debateTurnOutput), and `mergeModelSnapshots` dedupes on id,
      // so a schema-only id silently discarded all but the last failure.
      id: `fallback-${schemaName}-${role.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
      provider: "local",
      model: requestedModel,
      role,
      configured: true,
      failure: lastReason
    },
    placeholder: { requestedModel, reason: lastReason }
  };
}

function mergeModelSnapshots(roster: ModelSnapshot[], generated: ModelSnapshot[]): ModelSnapshot[] {
  const snapshots = new Map<string, ModelSnapshot>();

  for (const snapshot of [...roster, ...generated]) {
    snapshots.set(snapshot.id, snapshot);
  }

  return Array.from(snapshots.values());
}

function buildGenerationPrompt(input: {
  task: string;
  framed: FramedDebate;
  sources?: EvidenceSource[];
  claims?: Claim[];
  teams?: DebateTeam;
  turns?: RoundTurn[];
  expectedTurns?: RoundTurn[];
  scorecard?: Scorecard;
  round?: RoundTurn["round"];
  fallback: unknown;
}): string {
  return JSON.stringify(
    {
      task: input.task,
      rules: [
        "Return only JSON matching the requested schema.",
        "Make every visible sentence specific to the resolution and cited evidence.",
        "Do not preserve deterministic fallback wording when it is generic.",
        "Write for grades 5-8: short sentences, real debate moves, no baby talk.",
        "Do not write narrator voice in visible debate turns: avoid 'The YES side argues', 'The NO side says', 'the pro side', and 'the con side'. The frog must speak as I or my side.",
        "Do not write 'studies show', 'research says', 'evidence shows', or similar unless the claim is tied to a relevant source id in this JSON. If the source is only a debate-method source or placeholder, use a modest phrase like 'one reason is' instead.",
        "Do not mention pilots, rollback triggers, implementation phases, local accountability, or stakeholder safeguards unless the resolution actually asks about an implementation decision.",
        "For broad words such as kids, students, phones, AI, pets, animals, school, voting, or elections, name the scope when it matters instead of arguing as if every version of the idea is the same.",
        ...debateTranscriptRules(input.round),
        ...scopeClarificationRules(input.framed),
        ...judgePolicyRules(input.framed)
      ],
      roundGuide: buildRoundGuide(input),
      debate: {
        subject: input.framed.subject,
        context: input.framed.context,
        resolution: input.framed.resolution,
        topicKind: input.framed.topicKind,
        highStakes: input.framed.highStakes
      },
      round: input.round,
      sources: input.sources?.map((source) => ({
        id: source.id,
        title: source.title,
        publisher: source.publisher,
        snippet: source.snippet,
        quality: source.quality,
        retrievedVia: source.retrievedVia
      })),
      claims: input.claims?.map((claim) => ({
        id: claim.id,
        side: claim.side,
        text: claim.text,
        warrant: claim.warrant,
        evidenceSourceIds: claim.evidenceSourceIds,
        confidence: claim.confidence
      })),
      teams: input.teams
        ? {
            pro: input.teams.pro.map((agent) => ({
              id: agent.id,
              name: agent.name,
              role: agent.role,
              thesis: agent.thesis
            })),
            con: input.teams.con.map((agent) => ({
              id: agent.id,
              name: agent.name,
              role: agent.role,
              thesis: agent.thesis
            })),
            judge: input.teams.judge
          }
        : undefined,
      turns: input.turns?.map((turn) => ({
        round: turn.round,
        agentName: turn.agentName,
        side: turn.side,
        content: turn.content,
        claimIds: turn.claimIds,
        sourceIds: turn.sourceIds
      })),
      scorecard: input.scorecard,
      draftJsonToImprove: input.fallback
    },
    null,
    2
  );
}

function buildRoundGuide(input: {
  round?: RoundTurn["round"];
  expectedTurns?: RoundTurn[];
  turns?: RoundTurn[];
}): unknown {
  if (!input.round || input.round === "judge_review" || input.round === "synthesis") {
    return undefined;
  }

  const expectedTurns = input.expectedTurns ?? [];
  const previousTurns = input.turns ?? [];

  if (input.round === "rebuttal") {
    return {
      job: "Answer the opponent's Round 2 question before defending your side.",
      questionsToAnswer: expectedTurns.map((turn) => {
        const opponentQuestion = [...previousTurns]
          .reverse()
          .find((candidate) => candidate.round === "cross_examination" && candidate.side !== turn.side);
        return {
          side: turn.side,
          speaker: turn.agentName,
          opponentQuestion: opponentQuestion?.content ?? null
        };
      })
    };
  }

  if (input.round === "cross_examination") {
    return {
      job: "Ask exactly one pointed question that would make the other frog defend its weakest point.",
      expectedQuestionCount: expectedTurns.length
    };
  }

  if (input.round === "opening") {
    return {
      job: "Give a clear answer, the strongest reason, and one simple example.",
      expectedTurns: expectedTurns.map((turn) => ({ side: turn.side, speaker: turn.agentName }))
    };
  }

  if (input.round === "closing") {
    return {
      job: "Weigh the tradeoff and tell the viewer why your side should win overall.",
      expectedTurns: expectedTurns.map((turn) => ({ side: turn.side, speaker: turn.agentName }))
    };
  }

  return undefined;
}

function scopeClarificationRules(framed: FramedDebate): string[] {
  const normalized = `${framed.subject} ${framed.resolution} ${framed.context ?? ""}`.toLowerCase();
  const rules: string[] = [];

  if (/\b(kid|kids|child|children|minors?)\b/.test(normalized)) {
    rules.push(
      "When the question says kids or children, do not silently treat all ages the same. If age matters, distinguish young children from older teens in one plain sentence."
    );
  }

  if (/\b(vote|voting|election|elections)\b/.test(normalized) && /\b(kid|kids|child|children|minors?)\b/.test(normalized)) {
    rules.push(
      "For kids voting, distinguish the broad question 'all kids voting' from narrower ideas like 16- and 17-year-olds voting in local elections; the verdict may differ by scope."
    );
  }

  if (/\b(ai|artificial intelligence)\b/.test(normalized)) {
    rules.push("For AI questions, distinguish using AI as a helper from using AI to replace the student's own thinking.");
  }

  if (/\b(phone|phones|cell phone|smartphone)\b/.test(normalized)) {
    rules.push("For phone questions, distinguish emergency access or learning tools from unrestricted entertainment use.");
  }

  if (/\b(pet|pets|animal|animals)\b/.test(normalized)) {
    rules.push("For pet or animal questions, distinguish ordinary pets from trained service animals or supervised therapy programs.");
  }

  return rules;
}

function judgePolicyRules(framed: FramedDebate): string[] {
  const normalized = `${framed.subject} ${framed.resolution} ${framed.context ?? ""}`.toLowerCase();
  const schoolOrChildPolicy = /\b(school|student|students|kid|kids|child|children|classroom|teacher|teachers)\b/.test(
    normalized
  );
  const safetyOrAnimalPolicy = /\b(pet|pets|animal|animals|dog|dogs|cat|cats|allerg|bite|hygiene|safety|service animal)\b/.test(
    normalized
  );
  const civicChildPolicy = /\b(vote|voting|election|political|politics)\b/.test(normalized) && /\b(kid|kids|child|children|student|students)\b/.test(normalized);

  if (!(schoolOrChildPolicy || civicChildPolicy || safetyOrAnimalPolicy)) {
    return [];
  }

  const rules = [
    "Judge child-facing institutional policies using a burden-of-proof standard: the side changing the status quo must show concrete benefits plus workable safeguards, not just appealing intentions.",
    "Confidence above 0.65 requires that the winning side directly answered the strongest risks and implementation burdens with specific evidence or policy limits."
  ];

  if (schoolOrChildPolicy && safetyOrAnimalPolicy) {
    rules.push(
      "For pets or animals in schools, distinguish broad pet permission from narrowly governed service animals or therapy programs. Service-animal access is not evidence that ordinary pets should be broadly allowed.",
      "For pets or animals in schools, weigh allergies, bites, fear/phobias, hygiene, food-service rules, distraction, supervision, liability, and unequal access. If YES only argues emotional support, motivation, or responsibility while NO raises these risks, prefer NO or at most a low-confidence conditional YES."
    );
  }

  if (civicChildPolicy) {
    rules.push(
      "For children voting in political elections, require YES to answer maturity, coercion, civic knowledge, administration, and guardianship concerns before a confident YES is justified."
    );
  }

  return rules;
}

function calibrateScorecardForPolicyBurden(
  scorecard: Scorecard,
  framed: FramedDebate,
  claims: Claim[],
  turns: RoundTurn[]
): Scorecard {
  if (!isSchoolPetsResolution(framed)) {
    return scorecard;
  }

  const yesText = sideText("pro", claims, turns);
  const noText = sideText("con", claims, turns);
  const yesPolicyLimits = /\b(only|limited|limits?|designated|opt[- ]?out|permission|approved|service animals? only|therapy (dog|animal) program)\b/.test(
    yesText
  );
  const yesConcreteControls = [
    /\b(vaccin|health record|vet|screened|trained)\b/,
    /\b(supervis|handler|adult|staff)\b/,
    /\b(allergy plan|allerg(y|ies)|phobia|fear)\b/,
    /\b(cleaning|hygiene protocol|sanit|food[- ]?service)\b/,
    /\b(rule|rules|policy|liabil|insurance)\b/
  ].filter((pattern) => pattern.test(yesText)).length;
  const yesAddressedSafeguards = yesPolicyLimits && yesConcreteControls >= 2;
  const noRaisedConcreteRisks = /\b(allerg|bite|hygiene|sanit|supervis|liabil|phobia|fear|disrupt|food|safety|service animal)\b/.test(
    noText
  );

  if (!isYesRecommendation(scorecard.recommendation) && scorecard.recommendation !== "mixed") {
    return scorecard;
  }

  if (yesAddressedSafeguards || (!noRaisedConcreteRisks && scorecard.recommendation !== "mixed")) {
    return {
      ...scorecard,
      confidence: Math.min(scorecard.confidence, 0.62)
    };
  }

  return {
    ...scorecard,
    recommendation: "conditional_no",
    confidence:
      scorecard.recommendation === "mixed"
        ? Math.min(Math.max(scorecard.confidence, 0.62), 0.66)
        : Math.min(scorecard.confidence, 0.6),
    categories: scorecard.categories.map((category) => {
      if (category.name === "risk" || category.name === "practicality") {
        return {
          ...category,
          pro: Math.min(category.pro, category.con - 0.4),
          con: Math.max(category.con, category.pro + 0.8),
          note:
            "For broad pets-at-school permission, generic learning or emotional-support benefits do not overcome unaddressed safety, allergy, hygiene, supervision, and disruption risks."
        };
      }
      return category;
    })
  };
}

function isSchoolPetsResolution(framed: FramedDebate): boolean {
  const normalized = `${framed.subject} ${framed.resolution}`.toLowerCase();
  return /\b(school|classroom|student|students|kid|kids|child|children)\b/.test(normalized) && /\b(pet|pets|animal|animals|dog|dogs|cat|cats)\b/.test(normalized);
}

function isYesRecommendation(recommendation: Scorecard["recommendation"]): boolean {
  return recommendation === "lean_yes" || recommendation === "conditional_yes";
}

function sideText(side: "pro" | "con", claims: Claim[], turns: RoundTurn[]): string {
  return [
    ...claims.filter((claim) => claim.side === side).map((claim) => `${claim.text} ${claim.warrant}`),
    ...turns.filter((turn) => turn.side === side).map((turn) => turn.content)
  ]
    .join(" ")
    .toLowerCase();
}

function debateTranscriptRules(round?: RoundTurn["round"]): string[] {
  if (!round || round === "judge_review" || round === "synthesis") {
    return [];
  }

  const commonRules = [
    "Visible debate turns should read like a clean transcript of a frog speaking, not like a narrator summarizing a side.",
    "Each frog must speak in first person for its own argument: use I, me, my, or my side. Do not write 'The YES side argues' when the YES frog means itself, and do not write 'The NO side argues' when the NO frog means itself.",
    "When referring to the other debater, say my opponent, the other frog, you, or your side. Do not use Yes Frog or No Frog inside the spoken debate text because those names can be confusing in sentences.",
    "Avoid repeating a point from an earlier round unless this turn adds a new example, answers the opponent directly, or explains why one concern matters more.",
    "Keep each turn to 1 or 2 short paragraphs, about 35 to 75 words total, in kid-friendly spoken language.",
    "Do not include the speaker name inside content; agentName already identifies the speaker."
  ];

  switch (round) {
    case "opening":
      return [
        ...commonRules,
        "Opening round job: state your answer clearly, give your strongest reason, and include one simple concrete example. Do not rebut yet unless absolutely necessary.",
        "Good opening patterns: 'I think YES because...' or 'I do not think kids should...' Avoid 'the YES side' and 'the NO side' narration."
      ];
    case "cross_examination":
      return [
        ...commonRules,
        "Tough Questions round job: ask exactly one pointed question to the opposing frog. The content must end with a question mark.",
        "Do not summarize both sides in this round. Do not answer your own question.",
        "Good question patterns: 'If your plan..., why...?' or 'How would you answer...?'"
      ];
    case "rebuttal":
      return [
        ...commonRules,
        "Comeback round job: answer one specific thing the opponent said, then explain why your side still wins that clash.",
        "If this round has an opponent question in roundGuide.questionsToAnswer, answer that exact question first. Do not dodge it or switch to a different issue.",
        "Start by naming the opponent's point in plain speech, such as 'My opponent is right that...' or 'The other frog says...', then respond.",
        "Do not merely restate your opening. Add a comparison, an example, or a reason the opponent's point is not enough."
      ];
    case "closing":
      return [
        ...commonRules,
        "Last Word round job: tell the viewer why your side should win overall. Weigh the tradeoff; do not introduce a brand-new argument.",
        "Use a direct spoken close such as 'Vote YES because...' or 'Vote NO because...'.",
        "Do not say 'The YES side has shown' or 'The NO side has shown'; say what I showed, what my opponent missed, and what matters most."
      ];
    default:
      return commonRules;
  }
}

function polishDebateTurnContent(content: string, turn: GeneratedRoundTurn): string {
  let polished = content
    .replace(/\bYou says\b/g, "You said")
    .replace(/\byou says\b/g, "you said")
    .replace(/\bYou says that\b/g, "You said that")
    .replace(/\byou says that\b/g, "you said that")
    .replace(/\bYou say that\b/g, "You said that")
    .replace(/\byou say that\b/g, "you said that")
    .replace(/\bYou argues?\b/g, "You argued")
    .replace(/\byou argues?\b/g, "you argued")
    .replace(/\s+([,.?!])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (turn.side === "pro") {
    polished = polishOwnSideNarration(polished, "YES", "NO");
  } else if (turn.side === "con") {
    polished = polishOwnSideNarration(polished, "NO", "YES");
  }

  return polishSentenceStarts(polishNarratorSideLabels(polishFrogRoleNames(polished), turn.side));
}

function polishOwnSideNarration(content: string, ownSide: "YES" | "NO", opponentSide: "YES" | "NO"): string {
  const own = ownSide === "YES" ? "YES" : "NO";
  const ownFrog = ownSide === "YES" ? "Yes Frog" : "No Frog";
  const opponentFrog = opponentSide === "YES" ? "Yes Frog" : "No Frog";

  return content
    .replace(new RegExp(`\\bThe ${ownFrog}\\b`, "gi"), "I")
    .replace(new RegExp(`\\b${ownFrog}\\s+(?:says|said|argues?|claims?|points out)\\b`, "gi"), "I say")
    .replace(new RegExp(`\\b${ownFrog}'s\\s+case\\b`, "gi"), "my case")
    .replace(new RegExp(`\\b${ownFrog}\\b`, "gi"), "I")
    .replace(new RegExp(`\\bThe ${opponentFrog}\\b`, "gi"), "my opponent")
    .replace(new RegExp(`\\b${opponentFrog},\\s*`, "gi"), "My opponent, ")
    .replace(new RegExp(`\\b${opponentFrog}\\s+(says|said|argues?|claims?|points out)\\b`, "gi"), "my opponent $1")
    .replace(new RegExp(`\\b${opponentFrog}'s\\s+case\\b`, "gi"), "my opponent's case")
    .replace(new RegExp(`\\b${opponentFrog}\\b`, "gi"), "my opponent")
    .replace(new RegExp(`\\bThe ${own} side has shown that\\b`, "gi"), "I have shown that")
    .replace(new RegExp(`\\bThe ${own} side has shown\\b`, "gi"), "I have shown")
    .replace(new RegExp(`\\bThe ${own} side argues that\\b`, "gi"), "I argue that")
    .replace(new RegExp(`\\bThe ${own} side argues\\b`, "gi"), "I argue")
    .replace(new RegExp(`\\bThe ${own} side points out that\\b`, "gi"), "I point out that")
    .replace(new RegExp(`\\bThe ${own} side points out\\b`, "gi"), "I point out")
    .replace(new RegExp(`\\bThe ${own} side claims that\\b`, "gi"), "I claim that")
    .replace(new RegExp(`\\bThe ${own} side claims\\b`, "gi"), "I claim")
    .replace(new RegExp(`\\bThe ${own} side\\b`, "gi"), "my side")
    .replace(new RegExp(`\\bthe ${own} case\\b`, "gi"), "my case")
    .replace(new RegExp(`\\bThe ${opponentSide} side\\b`, "gi"), "my opponent")
    .replace(new RegExp(`\\bthe ${opponentSide} case\\b`, "gi"), "my opponent's case");
}

function polishFrogRoleNames(content: string): string {
  return content
    .replace(/\bthe YES frog\b/gi, "the green frog")
    .replace(/\bthe NO frog\b/gi, "the pink frog")
    .replace(/\bYES frog\b/gi, "green frog")
    .replace(/\bNO frog\b/gi, "pink frog")
    .replace(/\bYes Frog\b/g, "the green frog")
    .replace(/\bNo Frog\b/g, "the pink frog")
    .replace(/\s+([,.?!])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function polishNarratorSideLabels(content: string, side: GeneratedRoundTurn["side"]): string {
  if (side !== "pro" && side !== "con") {
    return content
      .replace(/\bThe YES side\b/gi, "the green frog")
      .replace(/\bthe YES side\b/gi, "the green frog")
      .replace(/\bYES side\b/gi, "green frog")
      .replace(/\bThe NO side\b/gi, "the pink frog")
      .replace(/\bthe NO side\b/gi, "the pink frog")
      .replace(/\bNO side\b/gi, "pink frog")
      .replace(/\bthe pro side\b/gi, "the green frog")
      .replace(/\bthe con side\b/gi, "the pink frog")
      .replace(/\bpro side\b/gi, "green frog")
      .replace(/\bcon side\b/gi, "pink frog")
      .replace(/\s+([,.?!])/g, "$1")
      .replace(/\s{2,}/g, " ")
      .trim();
  }
  const own = side === "pro" ? "YES" : "NO";
  const opponent = side === "pro" ? "NO" : "YES";

  return content
    .replace(new RegExp(`\\bThe ${own} side\\s+(?:says|said)\\s+that\\b`, "gi"), "I say that")
    .replace(new RegExp(`\\bThe ${own} side\\s+(?:says|said)\\b`, "gi"), "I say")
    .replace(new RegExp(`\\b${own} side\\s+(?:says|said)\\s+that\\b`, "gi"), "I say that")
    .replace(new RegExp(`\\b${own} side\\s+(?:says|said)\\b`, "gi"), "I say")
    .replace(new RegExp(`\\bThe ${opponent} side\\s+(?:says|said)\\s+that\\b`, "gi"), "my opponent says that")
    .replace(new RegExp(`\\bThe ${opponent} side\\s+(?:says|said)\\b`, "gi"), "my opponent says")
    .replace(new RegExp(`\\b${opponent} side\\s+(?:says|said)\\s+that\\b`, "gi"), "my opponent says that")
    .replace(new RegExp(`\\b${opponent} side\\s+(?:says|said)\\b`, "gi"), "my opponent says")
    .replace(new RegExp(`\\bThe ${own} side\\b`, "gi"), "my side")
    .replace(new RegExp(`\\bthe ${own} side\\b`, "gi"), "my side")
    .replace(new RegExp(`\\b${own} side\\b`, "gi"), "my side")
    .replace(new RegExp(`\\bThe ${opponent} side\\b`, "gi"), "my opponent")
    .replace(new RegExp(`\\bthe ${opponent} side\\b`, "gi"), "my opponent")
    .replace(new RegExp(`\\b${opponent} side\\b`, "gi"), "my opponent")
    .replace(/\bthe pro side\b/gi, side === "pro" ? "my side" : "my opponent")
    .replace(/\bthe con side\b/gi, side === "con" ? "my side" : "my opponent")
    .replace(/\bpro side\b/gi, side === "pro" ? "my side" : "my opponent")
    .replace(/\bcon side\b/gi, side === "con" ? "my side" : "my opponent")
    .replace(/\s+([,.?!])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function polishSentenceStarts(content: string): string {
  return content
    .replace(/([.!?]\s+)my\b/g, "$1My")
    .replace(/([.!?]\s+)i\b/g, "$1I")
    .replace(/([.!?]\s+)the other frog\b/g, "$1The other frog")
    .replace(/([.!?]\s+)my opponent\b/g, "$1My opponent")
    .trim();
}

function turnGenerationTask(councilSize: CouncilSize, expectedTurns: RoundTurn[]): string {
  if (councilSize !== "duo") {
    return "Write this debate round for the exact resolution. Keep the same agent ids, names, sides, round, claim ids, and source ids, but make the content sound like a live debate transcript: first-person speakers, direct clash, clear scope, and no narrator-style side summaries.";
  }

  const expected = expectedTurns
    .map((turn) => `${turn.agentName} must be side "${turn.side}" in round "${turn.round}"`)
    .join("; ");

  return `Write only the requested kid-friendly debate turn or turns for the exact question. ${expected}. Return exactly ${expectedTurns.length} turn(s), preserving each requested agent id, agent name, side, round, claim ids, and source ids. The visible content must sound like that frog speaking in first person, not a narrator summarizing "the YES side" or "the NO side." Refer to the other debater as my opponent, the other frog, you, or your side; do not write Yes Frog or No Frog inside the spoken text. Do not use pro, con, affirmative, or negative language in visible content. Make the content short, topic-specific, grounded in the claims and evidence, clear about scope when the question is broad, and meaningfully different from earlier turns.`;
}

function reconcileGeneratedTurns(
  generatedTurns: GeneratedRoundTurn[],
  expectedTurns: GeneratedRoundTurn[],
  config: DebateRuntimeConfig
): GeneratedRoundTurn[] {
  const reconciled = expectedTurns.map((expected) => {
    const generated = generatedTurns.find(
      (turn) =>
        turn.round === expected.round &&
        turn.side === expected.side &&
        turn.agentId === expected.agentId
    );

    if (!generated) return null;

    return {
      ...generated,
      round: expected.round,
      side: expected.side,
      agentId: expected.agentId,
      agentName: expected.agentName,
      claimIds: generated.claimIds.length > 0 ? generated.claimIds : expected.claimIds,
      sourceIds: generated.sourceIds.length > 0 ? generated.sourceIds : expected.sourceIds
    };
  });

  if (reconciled.every((turn): turn is GeneratedRoundTurn => Boolean(turn))) {
    return reconciled;
  }

  if (!config.allowDeterministicFallbacks) {
    throw new Error("Generated debate turn did not preserve the requested speaker, side, and round.");
  }

  return expectedTurns;
}

function normalizeSummary(
  summary: z.infer<typeof finalSummaryOutputSchema>,
  fallbackConfidence: number
): DebateRun["summary"] {
  const confidence = summary.confidence ?? fallbackConfidence;
  return {
    headline: polishJudgeVisibleCopy(summary.headline),
    recommendation: polishJudgeVisibleCopy(summary.recommendation),
    strongestPro: summary.strongestPro.map(polishJudgeVisibleCopy),
    strongestCon: summary.strongestCon.map(polishJudgeVisibleCopy),
    unresolvedUncertainties: summary.unresolvedUncertainties.map(polishJudgeVisibleCopy),
    whatWouldChangeMind: summary.whatWouldChangeMind.map(polishJudgeVisibleCopy),
    confidence: confidence > 1 ? confidence / 100 : confidence,
    highStakesDisclaimer: summary.highStakesDisclaimer
      ? polishJudgeVisibleCopy(summary.highStakesDisclaimer)
      : undefined
  };
}

function polishJudgeVisibleCopy(value: string): string {
  return value
    .replace(/\bthe pro side\b/gi, "the green frog")
    .replace(/\bthe con side\b/gi, "the pink frog")
    .replace(/\bpro side\b/gi, "green frog")
    .replace(/\bcon side\b/gi, "pink frog")
    .replace(/\bPro side\b/g, "green frog")
    .replace(/\bCon side\b/g, "pink frog")
    .replace(/\bthe YES frog\b/gi, "the green frog")
    .replace(/\bthe NO frog\b/gi, "the pink frog")
    .replace(/\bYES frog\b/gi, "green frog")
    .replace(/\bNO frog\b/gi, "pink frog")
    .replace(/\s+([,.?!])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
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
      model: config.yesModel,
      lens: "upside, option value, and second-order gains",
      side: "pro" as const
    },
    {
      name: "Risk Skeptic",
      model: config.noModel,
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
      model: config.yesModel,
      lens: "execution design, sequencing, and measurable checkpoints",
      side: "pro" as const
    },
    {
      name: "Equity Auditor",
      model: config.noModel,
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
            `The resolution may overstate what the evidence proves about ${framed.subject}.`,
            "Competing definitions, timeframes, or affected audiences may change the answer.",
            "The NO side should identify what the YES side is leaving out."
          ]
        : scout.side === "pro"
          ? [
              `The resolution may be defensible if the best evidence supports ${framed.subject}.`,
              "The YES side should define the comparison standard and defend it consistently.",
              "The alternative position may ignore important second-order or indirect effects."
            ]
          : [
              "The decision turns on evidence quality, definitions, and scope.",
              "Both sides need source-backed claims and explicit uncertainty.",
              "The synthesis should say what evidence would change the recommendation."
            ],
    model: `${scout.model}${index === 2 ? " (judge-calibrated)" : ""}`
  }));
}

function buildScoutThesis(side: "pro" | "con" | "neutral", lens: string, framed: FramedDebate): string {
  if (side === "pro") {
    return `From a ${lens} lens, ${framed.resolution} is plausible if the strongest evidence supports that framing.`;
  }

  if (side === "con") {
    return `From a ${lens} lens, ${framed.resolution} may fail if the comparison standard or evidence base favors the opposing case.`;
  }

  return `From a ${lens} lens, the right answer depends on evidence strength, scope, definitions, and uncertainty.`;
}

function buildDebateTeams(scouts: StanceScout[], councilSize: CouncilSize = "quartet"): DebateTeam {
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

  // In duo mode the single pro and single con agent each speak in every
  // round, so we give them a generic "debater" role label rather than the
  // round-specific quartet labels.
  const pro: DebateAgent[] =
    councilSize === "duo"
      ? [toAgent(pickPro(0), "pro debater", "pro")]
      : [toAgent(pickPro(0), "opening case", "pro"), toAgent(pickPro(1), "implementation rebuttal", "pro")];
  const con: DebateAgent[] =
    councilSize === "duo"
      ? [toAgent(pickCon(0), "con debater", "con")]
      : [toAgent(pickCon(0), "risk case", "con"), toAgent(pickCon(1), "stakeholder rebuttal", "con")];

  return {
    pro,
    con,
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
  const subject = framed.subject.replace(/[.?!]+$/, "");
  const sourceTitle = (index: number) => sources[index % Math.max(sources.length, 1)]?.title ?? "the cited evidence";
  const civicAgeQuestion = /\b(kids|children|minors)\b/i.test(subject) && /\b(vote|voting|election)\b/i.test(subject);

  return [
    {
      id: makeId("claim"),
      side: "pro",
      text: `The YES frog can win if it clearly explains what would make "${subject}" a good idea and backs that up with more than one kind of evidence.`,
      warrant: `A source such as "${sourceTitle(0)}" can help show the scope, mechanisms, or real-world reach behind the YES position.`,
      evidenceSourceIds: pick(0),
      confidence: civicAgeQuestion ? 0.58 : 0.72
    },
    {
      id: makeId("claim"),
      side: "pro",
      text: "The YES frog can win if the benefits reach enough students and matter enough to justify the change.",
      warrant: "A strong YES case should count both direct effects and important downstream consequences.",
      evidenceSourceIds: pick(1),
      confidence: civicAgeQuestion ? 0.56 : 0.68
    },
    {
      id: makeId("claim"),
      side: "pro",
      text: "The YES frog should point to evidence that the change would improve the school day more than keeping things as they are.",
      warrant: "Downstream effects can matter as much as immediate or obvious effects when judging a contested resolution.",
      evidenceSourceIds: pick(2),
      confidence: civicAgeQuestion ? 0.54 : 0.64
    },
    {
      id: makeId("claim"),
      side: "con",
      text: `The NO frog can win if the evidence does not show that "${subject}" would work better than the current approach.`,
      warrant: `A source such as "${sourceTitle(3)}" can expose whether the YES side is overstating reach relative to the alternative.`,
      evidenceSourceIds: pick(3),
      confidence: civicAgeQuestion ? 0.82 : 0.7
    },
    {
      id: makeId("claim"),
      side: "con",
      text: "The NO frog can win by separating what sounds appealing from what is actually proven to help.",
      warrant: "A position can be rhetorically attractive while a rival explanation or benchmark does more actual work.",
      evidenceSourceIds: pick(4),
      confidence: civicAgeQuestion ? 0.78 : 0.66
    },
    {
      id: makeId("claim"),
      side: "con",
      text: "The answer may change depending on which dimension of the question receives the most weight.",
      warrant: "A precise verdict should name the dimension being judged rather than collapsing all forms of evidence into one score.",
      evidenceSourceIds: pick(5),
      confidence: civicAgeQuestion ? 0.8 : 0.74
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
  const proLead = proClaims[0]?.text ?? `The pro side supports ${framed.resolution}.`;
  const proSecond = proClaims[1]?.text ?? proLead;
  const conLead = conClaims[0]?.text ?? `The con side challenges ${framed.resolution}.`;
  const conSecond = conClaims[1]?.text ?? conLead;
  const proEvidence = sourceLabel(sources, proClaims[0]?.evidenceSourceIds[0]);
  const conEvidence = sourceLabel(sources, conClaims[0]?.evidenceSourceIds[0]);
  // In duo mode there is only a single pro agent and a single con agent;
  // collapse the "second voice" references onto the same agent so every
  // round still has both sides speaking.
  const isDuo = teams.pro.length === 1 && teams.con.length === 1;
  const proA: DebateAgent = teams.pro[0];
  const proB: DebateAgent = teams.pro[1] ?? teams.pro[0];
  const conA: DebateAgent = teams.con[0];
  const conB: DebateAgent = teams.con[1] ?? teams.con[0];
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
      proA,
      "pro",
      `${proA.name}: I think YES. My main reason is this: ${proLead} One helpful source is ${proEvidence}.`,
      proClaims.slice(0, 2).map((claim) => claim.id)
    ),
    turn(
      "opening",
      conA,
      "con",
      `${conA.name}: I think NO. My main reason is this: ${conLead} One helpful source is ${conEvidence}.`,
      conClaims.slice(0, 2).map((claim) => claim.id)
    ),
    turn(
      "cross_examination",
      proB,
      "pro",
      `${proB.name}: My opponent, why should that concern matter more than my reason that ${lowercaseFirst(proSecond)}?`,
      claimIdsAt(proClaims, 1).concat(claimIdsAt(conClaims, 1))
    ),
    turn(
      "cross_examination",
      conB,
      "con",
      `${conB.name}: My opponent, what evidence would prove that ${lowercaseFirst(proLead)} enough to outweigh the risks?`,
      claimIdsAt(conClaims, 2).concat(claimIdsAt(proClaims, 0))
    ),
    turn(
      "rebuttal",
      proA,
      "pro",
      `${proA.name}: My opponent raises a fair worry, but I still think YES wins if the benefits are broad, deep, and useful later.`,
      proClaims.map((claim) => claim.id)
    ),
    turn(
      "rebuttal",
      conA,
      "con",
      `${conA.name}: My opponent's case depends on how we count the evidence. I still think NO wins if the risks or missing proof matter more than the promised benefits.`,
      conClaims.map((claim) => claim.id)
    ),
    turn(
      "closing",
      proB,
      "pro",
      `${proB.name}: Vote YES because my side explains more of the important facts and consequences.`,
      proClaims.map((claim) => claim.id)
    ),
    turn(
      "closing",
      conB,
      "con",
      `${conB.name}: Vote NO because my side explains the evidence better when both frogs are judged the same way.`,
      conClaims.map((claim) => claim.id)
    ),
    turn(
      "judge_review",
      teams.judge,
      "neutral",
      `${teams.judge.name}: The verdict depends on which standard matters most. YES needs to prove broad benefits; NO needs to show the other benchmark explains more.`,
      claims.map((claim) => claim.id)
    )
  ];


  const roundOrder: RoundTurn["round"][] = ["opening", "cross_examination", "rebuttal", "closing"];
  const activeRoundCount = isDuo ? roundOrder.length : Math.min(maxRounds, roundOrder.length);
  const activeRounds = new Set(roundOrder.slice(0, activeRoundCount));

  return turns.filter((item) => item.round === "judge_review" || activeRounds.has(item.round));
}

function sourceLabel(sources: EvidenceSource[], id: string | undefined): string {
  const source = sources.find((item) => item.id === id) ?? sources[0];
  return source ? `${source.publisher}: ${source.title}` : "the available evidence";
}

function buildScorecard(claims: Claim[], framed: FramedDebate): Scorecard {
  const proConfidence = average(claims.filter((claim) => claim.side === "pro").map((claim) => claim.confidence));
  const conConfidence = average(claims.filter((claim) => claim.side === "con").map((claim) => claim.confidence));
  const topicAdjustment = framed.topicKind === "decision" || framed.topicKind === "comparison" ? 0.2 : 0;
  const proBase = Math.round((proConfidence * 10 + topicAdjustment) * 10) / 10;
  const conBase = Math.round(conConfidence * 10 * 10) / 10;
  const spread = proBase - conBase;
  const recommendation =
    spread > 0.75
      ? "lean_yes"
      : spread > 0.15
        ? "conditional_yes"
        : spread < -0.75
          ? "lean_no"
          : spread < -0.15
            ? "conditional_no"
            : "mixed";

  return {
    recommendation,
    confidence: Math.min(0.86, Math.max(0.54, 0.64 + Math.abs(spread) / 18)),
    categories: [
      {
        name: "evidence",
        pro: proBase,
        con: conBase,
        note: `Both sides need evidence that directly speaks to ${framed.subject}.`
      },
      {
        name: "practicality",
        pro: Math.min(10, proBase + 0.7),
        con: Math.max(1, conBase - 0.2),
        note: "The pro case strengthens when it defines the comparison standard and applies it consistently."
      },
      {
        name: "risk",
        pro: Math.max(1, proBase - 0.8),
        con: Math.min(10, conBase + 0.8),
        note: "The con case is strongest when it exposes overbroad definitions or weak evidence transfer."
      },
      {
        name: "fairness",
        pro: Math.max(1, proBase - 0.2),
        con: Math.min(10, conBase + 0.3),
        note: "The judgment should not privilege a familiar or attractive framing over the strongest evidence without saying so."
      },
      {
        name: "reversibility",
        pro: Math.min(10, proBase + 0.5),
        con: Math.max(1, conBase - 0.4),
        note: "The verdict can change if the controlling metric changes."
      }
    ]
  };
}

function shortClaim(content: string | undefined, fallback: string): string {
  const text = (content ?? fallback).replace(/\s+/g, " ").trim();
  if (text.length <= 78) return text;
  const slice = text.slice(0, 78).trimEnd();
  const lastSpace = slice.lastIndexOf(" ");
  const shortened = lastSpace > 44 ? slice.slice(0, lastSpace) : slice;
  return shortened.replace(/[,:;.-]+$/, "");
}

function buildSummary(framed: FramedDebate, claims: Claim[], scorecard: Scorecard) {
  const proClaims = claims.filter((claim) => claim.side === "pro");
  const conClaims = claims.filter((claim) => claim.side === "con");
  const confidence = scorecard.confidence;
  const highStakesDisclaimer = framed.highStakes?.message;
  const scopeUncertainties = summaryScopeUncertainties(framed);
  const mindChangers = summaryScopeMindChangers(framed);
  const hinge = scopeUncertainties[0] ?? "Which definition or standard should control the verdict.";

  return {
    headline: `The judge weighs the strongest green and pink frog points.`,
    recommendation: `The verdict is ${scorecard.recommendation.replace("_", " ")}. The green frog's best point is ${shortClaim(proClaims[0]?.text, "the idea could help")}. The pink frog's best point is ${shortClaim(conClaims[0]?.text, "the idea may be risky or too broad")}.`,
    strongestPro: proClaims.map((claim) => claim.text),
    strongestCon: conClaims.map((claim) => claim.text),
    unresolvedUncertainties: [
      ...scopeUncertainties,
      "Whether broad appeal should count as much as deeper expert or institutional support.",
      "Whether the cited evidence compares both sides using the same standard."
    ],
    whatWouldChangeMind: [
      ...mindChangers,
      "Comparative evidence that strongly favors one side.",
      "A clearer definition of the controlling standard that changes which evidence matters most."
    ],
    confidence,
    highStakesDisclaimer
  };
}

function summaryScopeUncertainties(framed: FramedDebate): string[] {
  const normalized = `${framed.subject} ${framed.resolution} ${framed.context ?? ""}`.toLowerCase();

  if (/\b(vote|voting|election|elections)\b/.test(normalized) && /\b(kid|kids|child|children|minors?)\b/.test(normalized)) {
    return [
      "Whether kids means all children or older teens, such as 16- and 17-year-olds.",
      "Whether the question is about local elections, school votes, or national political elections."
    ];
  }

  if (/\b(kid|kids|child|children|minors?)\b/.test(normalized)) {
    return ["Whether the answer changes for young children versus older teens."];
  }

  if (/\b(ai|artificial intelligence)\b/.test(normalized)) {
    return ["Whether AI is being used as a helper or as a replacement for the student's own thinking."];
  }

  if (/\b(phone|phones|cell phone|smartphone)\b/.test(normalized)) {
    return ["Whether the rule allows limited school uses or unrestricted phone use."];
  }

  if (/\b(pet|pets|animal|animals)\b/.test(normalized)) {
    return ["Whether the rule covers ordinary pets or only trained service animals and supervised therapy programs."];
  }

  return ["Which definition or standard should control the verdict."];
}

function summaryScopeMindChangers(framed: FramedDebate): string[] {
  const normalized = `${framed.subject} ${framed.resolution} ${framed.context ?? ""}`.toLowerCase();

  if (/\b(vote|voting|election|elections)\b/.test(normalized) && /\b(kid|kids|child|children|minors?)\b/.test(normalized)) {
    return [
      "Evidence that older teen voters can participate responsibly in the election type being discussed.",
      "A clear plan for maturity, coercion, civic knowledge, and administration concerns."
    ];
  }

  return [];
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

function lowercaseFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
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
