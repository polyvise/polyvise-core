import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DebateRuntimeConfig } from "../debate/config";
import { LlmProviderFailure, type LlmProvider } from "../providers/llm";
import type {
  DebateEvent,
  DebateStatus,
  EvidenceSource,
  ModelSnapshot,
  PlaceholderInfo,
  RunTraceEntry
} from "../debate/types";

/**
 * Run machinery shared by every deliberation mode.
 *
 * These were private to the debate engine until consensus and the advisory
 * panel needed the same retry, fallback and trace behaviour. Nothing in here
 * knows what a mode does — it knows how to call a model, record what happened,
 * and say so honestly when the answer is deterministic filler.
 */

export type StepResult<T> =
  | string
  | {
      message: string;
      status?: RunTraceEntry["status"];
      value: T;
    };

/** Runs one workflow step, timing it and recording the outcome on the trace. */
export async function runStep<T>(
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

/**
 * Calls a model for structured output, retrying on schema-validation failures
 * and falling back to deterministic content when the provider gives up.
 *
 * A non-null `placeholder` in the result means the data IS the fallback and
 * MUST NOT be shown as a real answer.
 */
export async function generateStructured<TSchema extends z.ZodTypeAny>(
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
  let remaining = Math.max(1, config.llmMaxAttempts);
  let nextPrompt = prompt ?? JSON.stringify(fallbackParse.data);
  const history: ModelSnapshot[] = [];

  while (remaining > 0) {
    try {
      const result = await provider.generateStructured<unknown>({
        role, schemaName, prompt: nextPrompt, fallback: fallbackParse.data,
        jsonSchema: z.toJSONSchema(schema), sessionId, maxAttempts: remaining
      });
      remaining -= Math.max(1, result.snapshot.attempts?.length ?? 1);
      const parsed = schema.safeParse(result.data);
      if (!parsed.success) {
        lastReason = `Structured output validation failed: ${parsed.error.message}`;
        const attempts = result.snapshot.attempts?.map((entry, index, list) => index === list.length - 1
          ? { ...entry, status: "failed" as const, message: lastReason } : entry);
        history.push({ ...result.snapshot, failure: lastReason, attempts });
        lastSnapshot = mergeCallSnapshots(history, lastReason);
        nextPrompt = `${prompt ?? JSON.stringify(fallbackParse.data)}\n\nRepair the rejected JSON below. Fix the validation errors, keep supported content, and return the complete corrected object.\nRejected output: ${JSON.stringify(result.data)}\nValidation errors: ${parsed.error.message}`;
        continue;
      }
      history.push(result.snapshot);
      return { data: parsed.data, snapshot: mergeCallSnapshots(history), placeholder: null };
    } catch (error) {
      lastReason = error instanceof Error ? error.message : "Structured generation failed.";
      if (error instanceof LlmProviderFailure) {
        history.push(error.snapshot);
        lastSnapshot = mergeCallSnapshots(history, lastReason);
      }
      if (!config.allowDeterministicFallbacks) {
        if (lastSnapshot) throw new LlmProviderFailure(lastReason, lastSnapshot);
        throw error;
      }
      break;
    }
  }

  if (!config.allowDeterministicFallbacks) {
    if (lastSnapshot) throw new LlmProviderFailure(lastReason, lastSnapshot);
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

/** Include every billed/failed attempt when output validation needs a repair. */
function mergeCallSnapshots(history: ModelSnapshot[], failure?: string): ModelSnapshot {
  const latest = history[history.length - 1];
  const attempts = history.flatMap((snapshot) => snapshot.attempts ?? [{
    attempt: 1, mode: "json_object" as const, status: snapshot.failure ? "failed" as const : "ok" as const,
    durationMs: snapshot.latencyMs ?? 0, ...(snapshot.failure ? { message: snapshot.failure } : {})
  }]).map((attempt, index) => ({ ...attempt, attempt: index + 1 }));
  const sum = (field: "promptTokens" | "completionTokens" | "estimatedCostUsd") =>
    history.some(item => item[field] !== undefined) ? history.reduce((total, item) => total + (item[field] ?? 0), 0) : undefined;
  return { ...latest, failure, attempts,
    latencyMs: history.reduce((sum, item) => sum + (item.latencyMs ?? 0), 0),
    promptTokens: sum("promptTokens"),
    completionTokens: sum("completionTokens"),
    estimatedCostUsd: sum("estimatedCostUsd")
  };
}

export function mergeModelSnapshots(roster: ModelSnapshot[], generated: ModelSnapshot[]): ModelSnapshot[] {
  const snapshots = new Map<string, ModelSnapshot>();

  for (const snapshot of [...roster, ...generated]) {
    snapshots.set(snapshot.id, snapshot);
  }

  return Array.from(snapshots.values());
}

export type StageCopy = Record<string, { label: string; detail: string }>;

/**
 * Appends a stage event. Each mode passes its own copy table: the status
 * values are shared across modes so persistence needs no new enum, but
 * "Agents debated" would be a lie on a consensus run.
 */
export function pushEvent(
  events: DebateEvent[],
  debateId: string,
  runId: string,
  status: DebateStatus,
  stageCopy: StageCopy
): void {
  const copy = stageCopy[status] ?? {
    label: status,
    detail: "Run stage updated."
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

export function traceEntry(
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

/**
 * The shared half of every mode's prompt: the resolution under consideration,
 * the caller's context, and the graded evidence. Mode-specific instructions
 * and prior state get appended by the caller.
 */
export function buildFramingPrompt(input: {
  task: string;
  subject: string;
  resolution: string;
  context?: string;
  sources?: EvidenceSource[];
  fallback?: unknown;
}): string {
  const lines: string[] = [
    `TASK: ${input.task}`,
    "",
    `SUBJECT: ${input.subject}`,
    `RESOLUTION: ${input.resolution}`
  ];

  if (input.context) {
    lines.push(`CALLER CONTEXT: ${input.context}`);
  }

  if (input.sources?.length) {
    lines.push("", "EVIDENCE (cite by id):");
    for (const source of input.sources) {
      lines.push(`- ${source.id} [${source.quality}] ${source.title} — ${source.publisher}: ${source.snippet}`);
    }
  }

  if (input.fallback !== undefined) {
    lines.push("", "SHAPE TO MATCH (content is placeholder, structure is not):", JSON.stringify(input.fallback));
  }

  return lines.join("\n");
}

export function makeId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

export function now(): string {
  return new Date().toISOString();
}

export function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
