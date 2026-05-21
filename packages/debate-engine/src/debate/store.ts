import { randomUUID } from "node:crypto";
import { createDefaultLlmProvider } from "../providers/llm";
import { loadDebateRuntimeConfig, type DebateRuntimeConfig } from "./config";
import { debateRequestSchema, feedbackRequestSchema, followupOutputSchema } from "./schema";
import { frameDebateRequest, productNotes, runHybridCouncilDebate } from "./engine";
import { createDefaultDebateRepository, createDefaultFeedbackRepository } from "./repository";
import type {
  DebateLiveEvent,
  DebateRecord,
  DebateRequest,
  FollowupExchange,
  UserFeedback
} from "./types";

const repository = createDefaultDebateRepository();
const feedbackRepository = createDefaultFeedbackRepository();
export const DEBATE_UNAVAILABLE_MESSAGE =
  "The frogs couldn't start a debate right now. Please try again in a few minutes.";

type Listener = (event: DebateLiveEvent) => void;

class DebateEventBus {
  readonly buffer: DebateLiveEvent[] = [];
  private listeners = new Set<Listener>();
  private terminal = false;

  emit(event: DebateLiveEvent): void {
    this.buffer.push(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // listener errors should not break the run
      }
    }
    if (event.kind === "complete" || event.kind === "error") {
      this.terminal = true;
    }
  }

  subscribe(listener: Listener): () => void {
    // replay buffered events so a late subscriber catches up
    for (const event of this.buffer) {
      try {
        listener(event);
      } catch {
        // ignore
      }
    }
    if (this.terminal) {
      return () => {};
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  isTerminal(): boolean {
    return this.terminal;
  }
}

const buses = new Map<string, DebateEventBus>();

function getOrCreateBus(id: string): DebateEventBus {
  let bus = buses.get(id);
  if (!bus) {
    bus = new DebateEventBus();
    buses.set(id, bus);
  }
  return bus;
}

function scheduleBusCleanup(id: string, delayMs = 5 * 60 * 1000): void {
  setTimeout(() => {
    buses.delete(id);
  }, delayMs).unref?.();
}

function buildSeedRecord(input: DebateRequest): {
  record: DebateRecord;
  request: DebateRequest;
  config: DebateRuntimeConfig;
  framed: ReturnType<typeof frameDebateRequest>;
} {
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

  const baseConfig = loadDebateRuntimeConfig();
  const config: DebateRuntimeConfig = {
    ...baseConfig,
    quickModel: request.models?.quick?.trim() || baseConfig.quickModel,
    deepModel: request.models?.deep?.trim() || baseConfig.deepModel,
    yesModel: request.models?.yes?.trim() || request.models?.quick?.trim() || baseConfig.yesModel,
    noModel: request.models?.no?.trim() || request.models?.deep?.trim() || baseConfig.noModel,
    judgeModel: request.models?.judge?.trim() || baseConfig.judgeModel
  };

  return { record, request, config, framed };
}

export interface StartDebateResult {
  debate: DebateRecord;
  completion: Promise<DebateRecord>;
}

export async function startDebate(input: DebateRequest): Promise<StartDebateResult> {
  const { record, request, config, framed } = buildSeedRecord(input);
  await repository.save(record);
  const bus = getOrCreateBus(record.id);

  const completion = (async (): Promise<DebateRecord> => {
    try {
      const run = await runHybridCouncilDebate(record.id, request, framed, {
        config,
        emit: (event) => bus.emit(event)
      });
      const completed: DebateRecord = {
        ...record,
        status: run.status,
        latestRun: run,
        updatedAt: new Date().toISOString()
      };
      await repository.save(completed);
      scheduleBusCleanup(record.id);
      return completed;
    } catch (error) {
      bus.emit({ kind: "error", message: DEBATE_UNAVAILABLE_MESSAGE });
      const failed: DebateRecord = {
        ...record,
        status: "failed",
        updatedAt: new Date().toISOString()
      };
      await repository.save(failed);
      scheduleBusCleanup(record.id);
      throw error;
    }
  })();

  // Prevent unhandled rejection warnings when callers only consume via SSE.
  completion.catch(() => {});

  return { debate: record, completion };
}

export async function createDebate(input: DebateRequest): Promise<DebateRecord> {
  const { completion } = await startDebate(input);
  return completion;
}

export function subscribeToDebate(
  debateId: string,
  listener: Listener
): { unsubscribe: () => void; terminal: boolean } {
  const bus = buses.get(debateId);
  if (!bus) {
    return { unsubscribe: () => {}, terminal: true };
  }
  const unsubscribe = bus.subscribe(listener);
  return { unsubscribe, terminal: bus.isTerminal() };
}

export function getDebate(id: string): Promise<DebateRecord | null> {
  return repository.get(id);
}

export function listDebates(): Promise<DebateRecord[]> {
  return repository.list();
}

export async function submitFeedback(input: {
  app?: string;
  message: string;
  debateId?: string;
  pagePath?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}): Promise<UserFeedback> {
  const parsed = feedbackRequestSchema.parse(input);
  const feedback: UserFeedback = {
    id: `feedback_${randomUUID().slice(0, 12)}`,
    app: input.app?.trim() || "debatefrog",
    message: parsed.message,
    debateId: parsed.debateId || undefined,
    pagePath: parsed.pagePath || undefined,
    userAgent: input.userAgent?.trim() || undefined,
    metadata: input.metadata ?? {},
    createdAt: new Date().toISOString()
  };

  await feedbackRepository.save(feedback);
  return feedback;
}

export function listFeedback(): Promise<UserFeedback[]> {
  return feedbackRepository.list();
}

export async function addFollowup(debateId: string, question: string): Promise<FollowupExchange | null> {
  const debate = await getDebate(debateId);
  if (!debate?.latestRun) {
    return null;
  }

  const answer = await answerFollowup(question, debate);
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
  await repository.save(updated);

  return exchange;
}

async function answerFollowup(question: string, debate: DebateRecord): Promise<string> {
  const fallback = {
    answer: answerFollowupDeterministic(question, debate)
  };

  try {
    const result = await createDefaultLlmProvider().generateStructured<unknown>({
      role: "follow-up answer",
      schemaName: "followupOutput",
      prompt: JSON.stringify(fallback)
    });
    return followupOutputSchema.parse(result.data).answer;
  } catch {
    return fallback.answer;
  }
}

function answerFollowupDeterministic(question: string, debate: DebateRecord): string {
  const lowered = question.toLowerCase();
  const summary = debate.latestRun?.summary;

  if (!summary) {
    return "The debate has not completed yet, so this question cannot be answered from the run record.";
  }

  if (lowered.includes("change") || lowered.includes("mind")) {
    return `The clearest mind-changers are: ${summary.whatWouldChangeMind.join(" ")}`;
  }

  if (lowered.includes("risk") || lowered.includes("downside")) {
    return `The main downside is: ${summary.strongestCon[0]} The practical response is to make the first step reversible and name stop conditions before acting.`;
  }

  if (lowered.includes("source") || lowered.includes("evidence")) {
    const sources = debate.latestRun?.sources.slice(0, 3).map((source) => `${source.publisher}: ${source.title}`);
    return `The run leaned on these sources first: ${sources?.join("; ")}. Live search can replace development references when BRAVE_SEARCH_API_KEY or TAVILY_API_KEY is configured.`;
  }

  return `Based on the completed debate, the answer is conditional: ${summary.recommendation}`;
}
