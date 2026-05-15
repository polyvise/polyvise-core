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

export type DebateMode = "hybrid_council";
export type EvidenceMode = "cited";
export type PerspectiveSide = "pro" | "con" | "neutral";

export type DebateRound =
  | "opening"
  | "cross_examination"
  | "rebuttal"
  | "closing"
  | "judge_review"
  | "synthesis";

export interface DebateRequest {
  subject: string;
  context?: string;
  mode?: DebateMode;
  evidence?: EvidenceMode;
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
  retrievedVia: "brave" | "mock";
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
}

export interface RunArtifact {
  id: string;
  kind: "run_state" | "scouts" | "evidence" | "claims" | "turns" | "scorecard" | "summary" | "models";
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

export interface RunTraceEntry {
  id: string;
  step:
    | "frame"
    | "scout"
    | "team_builder"
    | "evidence"
    | "opening"
    | "cross_exam"
    | "rebuttal"
    | "judge"
    | "persist";
  status: "ok" | "warning" | "failed";
  message: string;
  at: string;
  durationMs?: number;
}

export interface HighStakesNotice {
  category: "medical" | "legal" | "financial" | "safety";
  message: string;
}
