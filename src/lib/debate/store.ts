import { randomUUID } from "node:crypto";
import { debateRequestSchema } from "./schema";
import { frameDebateRequest, productNotes, runHybridCouncilDebate } from "./engine";
import type { DebateRecord, DebateRequest, FollowupExchange } from "./types";

type PolyviseStore = {
  debates: Map<string, DebateRecord>;
};

const globalForStore = globalThis as typeof globalThis & {
  __polyviseStore?: PolyviseStore;
};

const store: PolyviseStore =
  globalForStore.__polyviseStore ??
  (globalForStore.__polyviseStore = {
    debates: new Map()
  });

export async function createDebate(input: DebateRequest): Promise<DebateRecord> {
  const request = debateRequestSchema.parse(input);
  const id = `debate_${randomUUID().slice(0, 10)}`;
  const framed = frameDebateRequest(request);
  const createdAt = new Date().toISOString();
  const record: DebateRecord = {
    id,
    subject: framed.subject,
    context: framed.context,
    mode: request.mode,
    evidence: request.evidence,
    status: "queued",
    resolution: framed.resolution,
    topicKind: framed.topicKind,
    highStakes: framed.highStakes,
    createdAt,
    updatedAt: createdAt,
    productNotes: productNotes(),
    followups: []
  };

  store.debates.set(id, record);

  try {
    const run = await runHybridCouncilDebate(id, request, framed);
    const completed: DebateRecord = {
      ...record,
      status: run.status,
      latestRun: run,
      updatedAt: new Date().toISOString()
    };
    store.debates.set(id, completed);
    return completed;
  } catch (error) {
    const failed: DebateRecord = {
      ...record,
      status: "failed",
      updatedAt: new Date().toISOString()
    };
    store.debates.set(id, failed);
    throw error;
  }
}

export function getDebate(id: string): DebateRecord | null {
  return store.debates.get(id) ?? null;
}

export function listDebates(): DebateRecord[] {
  return Array.from(store.debates.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function addFollowup(debateId: string, question: string): FollowupExchange | null {
  const debate = getDebate(debateId);
  if (!debate?.latestRun) {
    return null;
  }

  const answer = answerFollowup(question, debate);
  const exchange: FollowupExchange = {
    id: `followup_${randomUUID().slice(0, 8)}`,
    question,
    answer,
    createdAt: new Date().toISOString()
  };

  const updated = {
    ...debate,
    followups: [...debate.followups, exchange],
    updatedAt: new Date().toISOString()
  };
  store.debates.set(debateId, updated);

  return exchange;
}

function answerFollowup(question: string, debate: DebateRecord): string {
  const lowered = question.toLowerCase();
  const summary = debate.latestRun?.summary;

  if (!summary) {
    return "The debate has not completed yet, so Polyvise cannot answer from the run record.";
  }

  if (lowered.includes("change") || lowered.includes("mind")) {
    return `The clearest mind-changers are: ${summary.whatWouldChangeMind.join(" ")}`;
  }

  if (lowered.includes("risk") || lowered.includes("downside")) {
    return `The main downside is: ${summary.strongestCon[0]} The practical response is to make the first step reversible and name stop conditions before acting.`;
  }

  if (lowered.includes("source") || lowered.includes("evidence")) {
    const sources = debate.latestRun?.sources.slice(0, 3).map((source) => `${source.publisher}: ${source.title}`);
    return `The run leaned on these sources first: ${sources?.join("; ")}. Live Brave Search can replace development references when BRAVE_SEARCH_API_KEY is configured.`;
  }

  return `Based on the completed debate, the answer is conditional: ${summary.recommendation}`;
}
