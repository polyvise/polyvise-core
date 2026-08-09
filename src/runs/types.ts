import type {
  ArgumentEdge,
  ArgumentNode,
  Claim,
  CouncilSize,
  DebateEvent,
  DebateMode,
  DebateStatus,
  DebateSummary,
  DebateTeam,
  EvidenceSource,
  ModelSnapshot,
  RoundTurn,
  RunArtifact,
  RunPlaceholders,
  RunTraceEntry,
  Scorecard,
  StanceScout
} from "../debate/types";

/**
 * Every deliberation mode Polyvise can run.
 *
 * The three differ in what they produce, not in how a run is operated: all of
 * them frame a resolution, gather evidence, call models with retries, record a
 * trace, and mark deterministic fallbacks. That shared operation lives in
 * `RunEnvelope`; the part that actually differs lives in `RunResult`.
 *
 * Aliases `DebateMode`, which stays the canonical union because the request
 * shape and the persisted column both already use that name.
 */
export type RunMode = DebateMode;

/**
 * The mode-independent record of a run.
 *
 * Deliberately excludes anything that only one mode has. A consensus run has
 * no judge and an advisory panel has no opposing sides, so neither belongs
 * here — they live in the mode's own result, where the field names can be
 * honest about what they hold.
 */
export interface RunEnvelope<TResult extends RunResult = RunResult> {
  id: string;
  debateId: string;
  status: DebateStatus;
  startedAt: string;
  completedAt?: string;
  events: DebateEvent[];
  /** Graded evidence. Shared because every mode reasons from the same ledger. */
  sources: EvidenceSource[];
  modelSnapshots: ModelSnapshot[];
  artifactManifest: RunArtifact[];
  trace: RunTraceEntry[];
  /**
   * Which parts of this run are deterministic filler rather than model output.
   * Absent means "unknown", not "nothing fell back".
   */
  placeholders?: RunPlaceholders;
  result: TResult;
}

/** Discriminated on `mode`, so narrowing a run narrows its whole shape. */
export type RunResult = HybridCouncilResult | ConsensusResult | AdvisoryPanelResult;

/* ------------------------------------------------------------------ debate */

/**
 * The Hybrid Council payload, field-for-field what `DebateRun` has carried at
 * its top level since before the envelope existed. `toDebateRun` flattens this
 * back out for callers still on the old shape.
 */
export interface HybridCouncilResult {
  mode: "hybrid_council";
  councilSize?: CouncilSize;
  scouts: StanceScout[];
  teams: DebateTeam;
  claims: Claim[];
  argumentNodes: ArgumentNode[];
  argumentEdges: ArgumentEdge[];
  turns: RoundTurn[];
  scorecard: Scorecard;
  summary: DebateSummary;
}

/* --------------------------------------------------------------- consensus */

/**
 * A consensus agent has a lens but no side. That is the whole point of the
 * mode: nobody is assigned a position to defend, so convergence means
 * something.
 */
export interface ConsensusAgent {
  id: string;
  name: string;
  model: string;
  lens: string;
}

/**
 * Where an agent stands relative to the resolution, on a fixed ordinal scale.
 *
 * Prose answers cannot be compared across agents, so convergence is measured
 * on this instead: it maps to a number, which makes spread computable from the
 * positions rather than something a model gets to assert about itself.
 */
export const consensusStances = [
  "strongly_agree",
  "agree",
  "neutral",
  "disagree",
  "strongly_disagree"
] as const;

export type ConsensusStance = (typeof consensusStances)[number];

/** One agent's answer at one round. */
export interface ConsensusPosition {
  id: string;
  agentId: string;
  agentName: string;
  /** 1-based. Round 1 is the independent answer, before anyone sees the others. */
  round: number;
  stance: ConsensusStance;
  answer: string;
  rationale: string;
  /** 0..1 — the agent's own stated confidence, not a measure of agreement. */
  confidence: number;
  /**
   * Whether this agent's stance moved from its previous round. False in round
   * 1, where there is nothing to move from. Derived by comparing stances, not
   * taken on the model's word.
   */
  changedFromPrevious: boolean;
  sourceIds: string[];
  /** Only set when a real model call wrote this position. */
  model?: string;
}

export interface ConsensusRound {
  round: number;
  positions: ConsensusPosition[];
  /**
   * 0..1 disagreement across the panel at the end of this round. 0 is total
   * agreement. Computed from the positions, never asked of a model.
   */
  spread: number;
}

export interface ConsensusConvergence {
  /** True when the final spread is at or under the convergence threshold. */
  converged: boolean;
  finalAnswer: string;
  /** 0..1, the inverse of the final round's spread. */
  agreementLevel: number;
  /** Prose description of the range the panel settled into. */
  range: string;
  /** Spread after each round, so a caller can chart the convergence curve. */
  spreadByRound: number[];
}

/**
 * An agent whose final stance still differs from the panel's modal stance.
 *
 * Reported separately because "four agreed and one refused to budge" is a
 * materially different result from "five agreed", and an average hides it. Use
 * `ConsensusPosition.changedFromPrevious` for movement over rounds; this is
 * specifically about who was still outside the majority at the end.
 */
export interface ConsensusHoldout {
  agentId: string;
  agentName: string;
  stance: ConsensusStance;
  position: string;
  reason: string;
}

export interface ConsensusSummary {
  headline: string;
  finding: string;
  agreed: string[];
  contested: string[];
  unresolvedUncertainties: string[];
  /** 0..100, to match DebateSummary. */
  confidence: number;
  highStakesDisclaimer?: string;
}

export interface ConsensusResult {
  mode: "consensus";
  agents: ConsensusAgent[];
  rounds: ConsensusRound[];
  convergence: ConsensusConvergence;
  holdouts: ConsensusHoldout[];
  summary: ConsensusSummary;
}

/* ------------------------------------------------------------------- panel */

export const panelLensIds = ["economist", "ethicist", "operator", "skeptic"] as const;

export type PanelLensId = (typeof panelLensIds)[number];

export interface PanelLens {
  id: PanelLensId;
  name: string;
  model: string;
  /** What this lens is asked to weigh, in one line. */
  brief: string;
}

/**
 * One lens's advice, given without seeing the others. The panel is additive
 * rather than adversarial: these are four independent readings, not four
 * positions in an argument.
 */
export interface PanelAdvice {
  id: string;
  lensId: PanelLensId;
  lensName: string;
  recommendation: string;
  reasoning: string;
  keyRisks: string[];
  /** What would have to be true for this lens to endorse the decision. */
  conditions: string[];
  /** 0..1 */
  confidence: number;
  sourceIds: string[];
  /** Only set when a real model call wrote this advice. */
  model?: string;
}

export interface PanelAgreement {
  point: string;
  lensIds: PanelLensId[];
}

/**
 * A point the panel splits on. Keeping each lens's stance rather than a single
 * summary line is the difference between reporting a conflict and flattening
 * it into false agreement.
 */
export interface PanelConflict {
  point: string;
  positions: Array<{ lensId: PanelLensId; stance: string }>;
}

export interface PanelChairSynthesis {
  headline: string;
  throughLine: string;
  agreements: PanelAgreement[];
  conflicts: PanelConflict[];
  decisionGuidance: string;
  /** 0..100, to match DebateSummary. */
  confidence: number;
  highStakesDisclaimer?: string;
}

export interface AdvisoryPanelResult {
  mode: "advisory_panel";
  lenses: PanelLens[];
  advice: PanelAdvice[];
  chair: PanelChairSynthesis;
}

/* ----------------------------------------------------------------- aliases */

export type DebateRunEnvelope = RunEnvelope<HybridCouncilResult>;
export type ConsensusRunEnvelope = RunEnvelope<ConsensusResult>;
export type AdvisoryPanelRunEnvelope = RunEnvelope<AdvisoryPanelResult>;

export function isHybridCouncilRun(run: RunEnvelope): run is DebateRunEnvelope {
  return run.result.mode === "hybrid_council";
}

export function isConsensusRun(run: RunEnvelope): run is ConsensusRunEnvelope {
  return run.result.mode === "consensus";
}

export function isAdvisoryPanelRun(run: RunEnvelope): run is AdvisoryPanelRunEnvelope {
  return run.result.mode === "advisory_panel";
}
