import type { DebateRequest, DebateRun } from "@/lib/debate/types";
import { frameDebateRequest, runHybridCouncilDebate } from "@/lib/debate/engine";

export const debateWorkflowSteps = [
  "frame",
  "scout",
  "team_builder",
  "research",
  "rounds",
  "judge",
  "persist"
] as const;

export type DebateWorkflowStep = (typeof debateWorkflowSteps)[number];

export interface DurableWorkflowAdapter {
  enqueueDebate(input: DebateRequest): Promise<{ debateId: string; runId?: string }>;
  getRun(debateId: string): Promise<DebateRun | null>;
}

export async function runDebateWorkflowInline(debateId: string, input: DebateRequest): Promise<DebateRun> {
  const framed = frameDebateRequest(input);
  return runHybridCouncilDebate(debateId, input, framed);
}

export const inngestImplementationNote =
  "Production deployment should map debateWorkflowSteps to an Inngest function with retries per step, fan-out for stance scouts, and persisted step output.";
