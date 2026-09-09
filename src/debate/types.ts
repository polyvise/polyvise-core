export const debateStatuses = [
  "queued",
  "framing",
  "researching",
  "debating",
  "judging",
  "complete",
  "failed",
  "partial"
] as const;

export type DebateStatus = (typeof debateStatuses)[number];

export const topicKinds = ["policy", "value", "empirical", "decision", "comparison"] as const;

export type TopicKind = (typeof topicKinds)[number];

/**
 * The deliberation modes a run can use. Named `DebateMode` for continuity with
 * the persisted column and the existing request shape; `RunMode` in
 * `../runs/types` is the same union under the name the newer code uses.
 */
export type DebateMode = "hybrid_council" | "consensus" | "advisory_panel";
export type EvidenceMode = "cited";
export type PerspectiveSide = "pro" | "con" | "neutral";

/**
 * How many debaters per side participate in a Hybrid Council run.
 *
 * - "quartet" (default): two pro agents + two con agents + a neutral judge.
 *   This is the canonical Hybrid Council shape.
 * - "duo": one pro agent + one con agent + a neutral judge. The single pro
 *   and single con agent each speak in every round.
 */
export type CouncilSize = "duo" | "quartet";

export type DebateRound =
  | "opening"
  | "cross_examination"
  | "rebuttal"
  | "closing"
  | "judge_review"
  | "synthesis";

export interface DebateModelSelection {
  yes?: string;
  no?: string;
  quick?: string;
  deep?: string;
  judge?: string;
}

export interface DebateDevOptions {
  liveApis?: boolean;
}

/** Tuning for a `consensus` run. Ignored by the other modes. */
export interface ConsensusOptions {
  /** How many agents answer independently. 3–7, default 5. */
  agentCount?: number;
  /** Total rounds including the opening independent answer. 2–5, default 3. */
  rounds?: number;
  /**
   * Spread at or below which the panel counts as converged, 0..1. Default 0.25.
   * Raising it calls looser agreement "converged", so it is deliberately a
   * caller decision rather than a constant.
   */
  convergenceThreshold?: number;
}

/** Tuning for an `advisory_panel` run. Ignored by the other modes. */
export interface AdvisoryPanelOptions {
  /**
   * Which lenses sit on the panel. Defaults to all four. Order is preserved in
   * the rendered panel.
   */
  lenses?: Array<"economist" | "ethicist" | "operator" | "skeptic">;
}

export interface DebateRequest {
  subject: string;
  context?: string;
  mode?: DebateMode;
  evidence?: EvidenceMode;
  models?: DebateModelSelection;
  /**
   * Number of debaters per side. Defaults to "quartet" when omitted so
   * existing callers see no behavior change. Set to "duo" for a focused
   * 1-on-1 debate.
   *
   * Only meaningful when `mode` is "hybrid_council".
   */
  councilSize?: CouncilSize;
  consensus?: ConsensusOptions;
  panel?: AdvisoryPanelOptions;
  /**
   * Development-only overrides. Ignored in production.
   */
  devOptions?: DebateDevOptions;
}

export interface DebateRecord {
  id: string;
  subject: string;
  context?: string;
  mode: DebateMode;
  evidence: EvidenceMode;
  status: DebateStatus;
  resolution: string;
  topicKind: TopicKind;
  highStakes: HighStakesNotice | null;
  createdAt: string;
  updatedAt: string;
  latestRun?: DebateRun;
  productNotes: ProductNote[];
  followups: FollowupExchange[];
}

export interface DebateRun {
  id: string;
  debateId: string;
  status: DebateStatus;
  startedAt: string;
  completedAt?: string;
  /**
   * The council shape this run actually used. Optional because runs persisted
   * before this field existed cannot report it.
   */
  councilSize?: CouncilSize;
  events: DebateEvent[];
  scouts: StanceScout[];
  teams: DebateTeam;
  sources: EvidenceSource[];
  claims: Claim[];
  argumentNodes: ArgumentNode[];
  argumentEdges: ArgumentEdge[];
  turns: RoundTurn[];
  scorecard: Scorecard;
  summary: DebateSummary;
  modelSnapshots: ModelSnapshot[];
  artifactManifest: RunArtifact[];
  trace: RunTraceEntry[];
  /**
   * Which parts of this run are deterministic filler rather than model output.
   *
   * The live event stream carries a per-step `placeholder`, but a consumer
   * reading a stored run has no other way to tell: fallback turns sit in
   * `turns` looking exactly like real ones. Anything named here MUST NOT be
   * presented as a real answer.
   *
   * Optional because runs persisted before this field existed cannot report
   * it — absent means "unknown", not "nothing fell back".
   */
  placeholders?: RunPlaceholders;
}

/**
 * Deterministic-fallback markers for a whole run, keyed by the step that fell
 * back. Turns are keyed by round, so one failed round doesn't discard the
 * rounds that succeeded.
 */
export interface RunPlaceholders {
  scouts?: PlaceholderInfo;
  claims?: PlaceholderInfo;
  turns?: Partial<Record<DebateRound, PlaceholderInfo>>;
  scorecard?: PlaceholderInfo;
  summary?: PlaceholderInfo;
}

export interface DebateEvent {
  id: string;
  debateId: string;
  runId: string;
  status: DebateStatus;
  label: string;
  detail: string;
  createdAt: string;
}

export interface StanceScout {
  id: string;
  name: string;
  model: string;
  lens: string;
  side: PerspectiveSide;
  thesis: string;
  assumptions: string[];
  strongestArguments: string[];
}

export interface DebateAgent {
  id: string;
  name: string;
  side: Exclude<PerspectiveSide, "neutral">;
  model: string;
  role: string;
  thesis: string;
}

export interface DebateTeam {
  pro: DebateAgent[];
  con: DebateAgent[];
  judge: {
    id: string;
    name: string;
    model: string;
    role: string;
  };
}

export interface EvidenceSource {
  id: string;
  title: string;
  url: string;
  publisher: string;
  publishedAt?: string;
  snippet: string;
  quality: "primary" | "expert" | "methodology" | "context";
  retrievedVia: "brave" | "mock" | "tavily";
  status: "accepted" | "needs_review" | "rejected";
}

export interface Claim {
  id: string;
  side: PerspectiveSide;
  text: string;
  warrant: string;
  evidenceSourceIds: string[];
  confidence: number;
}

export interface ArgumentNode {
  id: string;
  kind: "resolution" | "claim" | "evidence" | "uncertainty" | "summary";
  side: PerspectiveSide;
  label: string;
  detail: string;
  sourceId?: string;
}

export interface ArgumentEdge {
  id: string;
  source: string;
  target: string;
  relation: "supports" | "challenges" | "qualifies" | "summarizes";
}

export interface RoundTurn {
  id: string;
  round: DebateRound;
  agentId: string;
  agentName: string;
  side: PerspectiveSide;
  content: string;
  claimIds: string[];
  sourceIds: string[];
  createdAt: string;
  /**
   * The model that actually wrote this turn. Only set when a real model call
   * produced it — a turn left over from a fallback batch has no model to name,
   * and claiming one would be worse than leaving it blank.
   */
  model?: string;
}

export interface Scorecard {
  recommendation: "conditional_yes" | "lean_yes" | "mixed" | "lean_no" | "conditional_no";
  confidence: number;
  categories: Array<{
    name: "evidence" | "practicality" | "risk" | "fairness" | "reversibility";
    pro: number;
    con: number;
    note: string;
  }>;
}

export interface DebateSummary {
  headline: string;
  recommendation: string;
  strongestPro: string[];
  strongestCon: string[];
  unresolvedUncertainties: string[];
  whatWouldChangeMind: string[];
  confidence: number;
  highStakesDisclaimer?: string;
}

export interface ModelSnapshot {
  id: string;
  provider: "openai" | "anthropic" | "google" | "openrouter" | "local";
  model: string;
  role: string;
  configured: boolean;
  latencyMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  estimatedCostUsd?: number;
  failure?: string;
  attempts?: ModelCallAttempt[];
}

export interface ModelCallAttempt {
  attempt: number;
  mode: "json_schema" | "json_object";
  status: "ok" | "failed";
  durationMs: number;
  message?: string;
}

export interface RunArtifact {
  id: string;
  /**
   * Artifact kinds across every mode. `scouts` through `scorecard` are the
   * debate's; `positions` and `convergence` belong to consensus, `lenses`,
   * `advice` and `synthesis` to the advisory panel.
   */
  kind:
    | "run_state"
    | "scouts"
    | "evidence"
    | "claims"
    | "turns"
    | "scorecard"
    | "summary"
    | "models"
    | "positions"
    | "convergence"
    | "lenses"
    | "advice"
    | "synthesis";
  label: string;
  recordCount: number;
  createdAt: string;
}

export interface ProductNote {
  id: string;
  title: string;
  mode: "debate_showcase" | "model_lab";
  note: string;
  priority: "later" | "research" | "candidate";
}

export interface FollowupExchange {
  id: string;
  question: string;
  answer: string;
  createdAt: string;
}

export interface UserFeedback {
  id: string;
  app: string;
  message: string;
  debateId?: string;
  pagePath?: string;
  userAgent?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface RunTraceEntry {
  id: string;
  /**
   * Steps from every mode share one union so a single trace viewer can render
   * any run. The debate steps come first; `answer` through `chair` belong to
   * consensus and the advisory panel.
   */
  step:
    | "frame"
    | "scout"
    | "team_builder"
    | "evidence"
    | "opening"
    | "cross_exam"
    | "rebuttal"
    | "closing"
    | "judge_review"
    | "judge"
    | "persist"
    | "panel_builder"
    | "answer"
    | "revise"
    | "converge"
    | "advise"
    | "chair";
  status: "ok" | "warning" | "failed";
  message: string;
  at: string;
  durationMs?: number;
}

export interface HighStakesNotice {
  category: "medical" | "legal" | "financial" | "safety";
  message: string;
}

/**
 * A step that fell back to deterministic placeholder content because the
 * configured LLM either failed or returned an unusable response.
 *
 * When this is present on an event, the data payload IS the deterministic
 * fallback and MUST NOT be presented to the user as a real answer.
 */
export interface PlaceholderInfo {
  /** Model id that was supposed to run this step. */
  requestedModel: string;
  /** Human-readable explanation of why the call failed. */
  reason: string;
}

export type DebateLiveEvent =
  | { kind: "stage"; status: DebateStatus }
  | { kind: "framed"; resolution: string; topicKind: TopicKind; highStakes: HighStakesNotice | null }
  | { kind: "scouts"; scouts: StanceScout[]; placeholder?: PlaceholderInfo }
  | { kind: "teams"; teams: DebateTeam }
  | { kind: "sources"; sources: EvidenceSource[] }
  | { kind: "claims"; claims: Claim[]; placeholder?: PlaceholderInfo }
  | { kind: "argument_map"; nodes: ArgumentNode[]; edges: ArgumentEdge[] }
  | { kind: "turns"; round: DebateRound; turns: RoundTurn[]; placeholder?: PlaceholderInfo }
  | { kind: "scorecard"; scorecard: Scorecard; placeholder?: PlaceholderInfo }
  | { kind: "summary"; summary: DebateSummary; placeholder?: PlaceholderInfo }
  | { kind: "model_snapshot"; snapshot: ModelSnapshot }
  | { kind: "complete"; runId: string }
  | { kind: "error"; message: string };
