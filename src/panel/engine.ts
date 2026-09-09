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
  AdvisoryPanelResult,
  AdvisoryPanelRunEnvelope,
  PanelAdvice,
  PanelChairSynthesis,
  PanelLens,
  PanelLensId
} from "../runs/types";
import { panelLensIds } from "../runs/types";
import { panelAdviceOutputSchema, panelChairOutputSchema } from "./schema";

const stageCopy: StageCopy = {
  queued: {
    label: "Advisory panel queued",
    detail: "The subject was accepted and an advisory panel was initialized."
  },
  framing: {
    label: "Panel seated",
    detail: "The question was framed and each lens was given its brief."
  },
  researching: {
    label: "Evidence gathered",
    detail: "Sources were collected, graded, and shared with every lens."
  },
  debating: {
    label: "Lenses advised",
    detail: "Each lens gave its advice separately, without seeing the others."
  },
  judging: {
    label: "Chair synthesized",
    detail: "The chair mapped where the panel agrees and where it genuinely conflicts."
  },
  complete: {
    label: "Advisory panel complete",
    detail: "The per-lens advice, agreement map, and conflict record are ready."
  }
};

/**
 * The standing brief for each lens. These are fixed rather than model-authored:
 * the value of the mode is that the same four viewpoints are applied every
 * time, so two runs can be compared.
 */
const lensBriefs: Record<PanelLensId, { name: string; brief: string; role: string }> = {
  economist: {
    name: "Economist",
    brief: "Costs, incentives, tradeoffs, and what is given up by choosing this",
    role: "panel economist"
  },
  ethicist: {
    name: "Ethicist",
    brief: "Who is affected, who decides, and whether the distribution is defensible",
    role: "panel ethicist"
  },
  operator: {
    name: "Operator",
    brief: "What execution actually takes: sequencing, staffing, failure modes in practice",
    role: "panel operator"
  },
  skeptic: {
    name: "Skeptic",
    brief: "Where the case is weakest, what is being assumed, and what would falsify it",
    role: "panel skeptic"
  }
};

export type AdvisoryPanelEventEmitter = (event: AdvisoryPanelLiveEvent) => void;

export type AdvisoryPanelLiveEvent =
  | { kind: "stage"; status: AdvisoryPanelRunEnvelope["status"] }
  | { kind: "framed"; resolution: string; topicKind: FramedDebate["topicKind"]; highStakes: FramedDebate["highStakes"] }
  | { kind: "lenses"; lenses: PanelLens[] }
  | { kind: "sources"; sources: EvidenceSource[] }
  | { kind: "advice"; advice: PanelAdvice; placeholder?: PlaceholderInfo }
  | { kind: "chair"; chair: PanelChairSynthesis; placeholder?: PlaceholderInfo }
  | { kind: "model_snapshot"; snapshot: ModelSnapshot }
  | { kind: "complete"; runId: string }
  | { kind: "error"; message: string };

export interface AdvisoryPanelExecutionOptions {
  provider?: LlmProvider;
  config?: DebateRuntimeConfig;
  emit?: AdvisoryPanelEventEmitter;
}

export async function runAdvisoryPanel(
  debateId: string,
  request: DebateRequest,
  framed: FramedDebate = frameDebateRequest(request),
  options: AdvisoryPanelExecutionOptions = {}
): Promise<AdvisoryPanelRunEnvelope> {
  const config = options.config ?? configForRequest(loadDebateRuntimeConfig(), request);
  const provider = options.provider ?? createDefaultLlmProvider(config);
  const emit = options.emit ?? (() => {});

  const runId = makeId("run");
  const startedAt = now();
  const events: DebateEvent[] = [];
  const trace: RunTraceEntry[] = [];
  const snapshots: ModelSnapshot[] = [];
  const placeholders: RunPlaceholders = {};

  const selected = dedupeLenses(request.panel?.lenses ?? [...panelLensIds]);

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

  /* ----------------------------------------------------------- seat panel */

  pushEvent(events, debateId, runId, "framing", stageCopy);
  emit({ kind: "stage", status: "framing" });

  const lenses = await runStep(trace, "panel_builder", async () => {
    const seated: PanelLens[] = selected.map((id) => ({
      id,
      name: lensBriefs[id].name,
      brief: lensBriefs[id].brief,
      model: provider.modelForRole(lensBriefs[id].role)
    }));
    return { message: `${seated.length} lenses seated.`, value: seated };
  });
  emit({ kind: "lenses", lenses });

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

  /* --------------------------------------------------------------- advice */

  pushEvent(events, debateId, runId, "debating", stageCopy);
  emit({ kind: "stage", status: "debating" });

  const advice: PanelAdvice[] = [];
  let advicePlaceholder: PlaceholderInfo | null = null;

  // One call per lens, each blind to the others. A lens that had already read
  // the panel would be responding to it, and the chair's agreement map would
  // then be measuring echo rather than independent convergence.
  for (const lens of lenses) {
    const given = await runStep(trace, "advise", async () => {
      const fallback = {
        recommendation: `No advice was produced from the ${lens.name.toLowerCase()} lens.`,
        reasoning: `The ${lens.name.toLowerCase()} lens did not return usable output for this question.`,
        keyRisks: [] as string[],
        conditions: [] as string[],
        confidence: 0.3,
        sourceIds: [] as string[]
      };

      const { data, snapshot, placeholder } = await generateStructured(
        provider,
        lensBriefs[lens.id].role,
        "panelAdviceOutput",
        fallback,
        panelAdviceOutputSchema,
        config,
        buildFramingPrompt({
          task: `You are the ${lens.name} on an advisory panel. Your remit: ${lens.brief}. Advise on the resolution from that vantage point only — do not try to cover the whole question or to balance other perspectives, because other advisors hold them. You have not seen their advice. State plainly what you would do and what would have to be true for you to endorse it. Cite evidence by id where it bears on your reasoning.`,
          subject: framed.subject,
          resolution: framed.resolution,
          context: framed.context,
          sources,
          fallback
        }),
        runId
      );
      recordSnapshot(snapshot);
      advicePlaceholder = advicePlaceholder ?? placeholder;

      const entry: PanelAdvice = {
        id: makeId("advice"),
        lensId: lens.id,
        lensName: lens.name,
        recommendation: data.recommendation,
        reasoning: data.reasoning,
        keyRisks: data.keyRisks,
        conditions: data.conditions,
        confidence: data.confidence,
        sourceIds: data.sourceIds,
        ...(placeholder ? {} : { model: snapshot.model })
      };

      return { message: `${lens.name} advised.`, value: { entry, placeholder } };
    });

    advice.push(given.entry);
    emit({ kind: "advice", advice: given.entry, ...(given.placeholder ? { placeholder: given.placeholder } : {}) });
  }
  if (advicePlaceholder) placeholders.claims = advicePlaceholder;

  /* ---------------------------------------------------------------- chair */

  pushEvent(events, debateId, runId, "judging", stageCopy);
  emit({ kind: "stage", status: "judging" });

  let chairPlaceholder: PlaceholderInfo | null = null;
  const chair = await runStep(trace, "chair", async () => {
    const fallback: {
      headline: string;
      throughLine: string;
      agreements: Array<{ point: string; lensIds: PanelLensId[] }>;
      conflicts: Array<{ point: string; positions: Array<{ lensId: PanelLensId; stance: string }> }>;
      decisionGuidance: string;
      confidence: number;
      highStakesDisclaimer: string | null;
    } = {
      headline: "The panel advised without a chair synthesis.",
      throughLine: `${advice.length} lenses advised on the resolution.`,
      agreements: [],
      conflicts: [],
      decisionGuidance: "Read each lens's advice directly; no synthesis was produced.",
      confidence: 30,
      highStakesDisclaimer: framed.highStakes?.message ?? null
    };

    const { data, snapshot, placeholder } = await generateStructured(
      provider,
      "panel chair",
      "panelChairOutput",
      fallback,
      panelChairOutputSchema,
      config,
      buildChairPrompt({ framed, sources, advice, fallback }),
      runId
    );
    recordSnapshot(snapshot);
    chairPlaceholder = placeholder;

    return { message: `Chair mapped ${data.agreements.length} agreements and ${data.conflicts.length} conflicts.`, value: data };
  });
  if (chairPlaceholder) placeholders.summary = chairPlaceholder;

  const seatedIds = new Set(lenses.map((lens) => lens.id));
  const synthesis: PanelChairSynthesis = {
    headline: chair.headline,
    throughLine: chair.throughLine,
    // A chair that attributes a view to a lens which never sat on this panel
    // has invented it, so those attributions are dropped rather than shown.
    agreements: chair.agreements
      .map((agreement) => ({ ...agreement, lensIds: agreement.lensIds.filter((id) => seatedIds.has(id)) }))
      .filter((agreement) => agreement.lensIds.length >= 2),
    conflicts: chair.conflicts
      .map((conflict) => ({
        ...conflict,
        positions: conflict.positions.filter((position) => seatedIds.has(position.lensId))
      }))
      .filter((conflict) => conflict.positions.length >= 2),
    decisionGuidance: chair.decisionGuidance,
    confidence: chair.confidence ?? 50,
    ...(chair.highStakesDisclaimer ? { highStakesDisclaimer: chair.highStakesDisclaimer } : {})
  };
  emit({ kind: "chair", chair: synthesis, ...(chairPlaceholder ? { placeholder: chairPlaceholder } : {}) });

  pushEvent(events, debateId, runId, "complete", stageCopy);
  emit({ kind: "stage", status: "complete" });
  emit({ kind: "complete", runId });

  const modelSnapshots = mergeModelSnapshots(modelRosterFromConfig(config), snapshots);
  const result: AdvisoryPanelResult = { mode: "advisory_panel", lenses, advice, chair: synthesis };

  await runStep(trace, "persist", async () => "Advisory panel run assembled for repository persistence.");

  return {
    id: runId,
    debateId,
    status: "complete",
    startedAt,
    completedAt: now(),
    events,
    sources,
    modelSnapshots,
    artifactManifest: buildArtifactManifest({ lenses, advice, sources, modelSnapshots }),
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

function buildChairPrompt(input: {
  framed: FramedDebate;
  sources: EvidenceSource[];
  advice: PanelAdvice[];
  fallback: unknown;
}): string {
  const { framed, sources, advice, fallback } = input;

  const lines = [
    buildFramingPrompt({
      task: "You chaired this advisory panel. Map where the advisors actually agree and where they genuinely conflict. Do not resolve a conflict by picking a winner and do not soften one into agreement — an unresolved disagreement between advisors is the most useful thing you can report. Only list an agreement when at least two named advisors made that point. Attribute every position to the advisor who actually made it.",
      subject: framed.subject,
      resolution: framed.resolution,
      context: framed.context,
      sources,
      fallback
    }),
    "",
    `ADVISORS ON THIS PANEL: ${advice.map((entry) => `${entry.lensName} (${entry.lensId})`).join(", ")}.`,
    "Use only these lensIds.",
    "",
    "ADVICE RECEIVED:"
  ];

  for (const entry of advice) {
    lines.push(
      "",
      `--- ${entry.lensName} (${entry.lensId}), confidence ${entry.confidence.toFixed(2)}`,
      `RECOMMENDS: ${entry.recommendation}`,
      `REASONING: ${entry.reasoning}`
    );
    if (entry.keyRisks.length) {
      lines.push(`RISKS: ${entry.keyRisks.join("; ")}`);
    }
    if (entry.conditions.length) {
      lines.push(`CONDITIONS: ${entry.conditions.join("; ")}`);
    }
  }

  return lines.join("\n");
}

/** Preserves caller order, drops repeats, and never seats an empty panel. */
function dedupeLenses(requested: PanelLensId[]): PanelLensId[] {
  const seen = new Set<PanelLensId>();
  const ordered: PanelLensId[] = [];

  for (const id of requested) {
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }

  return ordered.length ? ordered : [...panelLensIds];
}

function buildArtifactManifest(input: {
  lenses: PanelLens[];
  advice: PanelAdvice[];
  sources: EvidenceSource[];
  modelSnapshots: ModelSnapshot[];
}): RunArtifact[] {
  const createdAt = now();

  return [
    { id: makeId("artifact"), kind: "run_state", label: "Advisory panel run state", recordCount: 1, createdAt },
    { id: makeId("artifact"), kind: "lenses", label: "Panel lenses", recordCount: input.lenses.length, createdAt },
    { id: makeId("artifact"), kind: "evidence", label: "Source ledger", recordCount: input.sources.length, createdAt },
    { id: makeId("artifact"), kind: "advice", label: "Per-lens advice", recordCount: input.advice.length, createdAt },
    { id: makeId("artifact"), kind: "synthesis", label: "Chair synthesis", recordCount: 1, createdAt },
    {
      id: makeId("artifact"),
      kind: "models",
      label: "Model snapshots",
      recordCount: input.modelSnapshots.length,
      createdAt
    }
  ];
}
