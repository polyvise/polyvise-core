import type { ModelSnapshot, RunPlaceholders, RunTraceEntry } from "../debate/types";

/** Server-owned execution state. Persist privately; never accept it from an end user. */
export interface RunCheckpoint {
  version: 1;
  debateId: string;
  runId: string;
  startedAt: string;
  inputKey: string;
  completed: Record<string, { value?: unknown }>;
  snapshots: ModelSnapshot[];
  placeholders: RunPlaceholders;
  trace: RunTraceEntry[];
  failedStep?: string;
}

export class RunCheckpointJournal {
  readonly state: RunCheckpoint;

  constructor(
    initial: RunCheckpoint,
    restored?: RunCheckpoint,
    private readonly persist?: (checkpoint: RunCheckpoint) => void | Promise<void>
  ) {
    if (restored && (restored.version !== 1 || restored.debateId !== initial.debateId || restored.inputKey !== initial.inputKey)) {
      throw new Error("This checkpoint belongs to a different debate or execution configuration.");
    }
    this.state = structuredClone(restored ?? initial);
    delete this.state.failedStep;
  }

  has(key: string): boolean {
    return Object.hasOwn(this.state.completed, key);
  }

  async run<T>(key: string, execute: () => Promise<T>): Promise<T> {
    if (this.has(key)) return structuredClone(this.state.completed[key].value) as T;
    try {
      const value = await execute();
      this.state.completed[key] = { value: structuredClone(value) };
      await this.persist?.(structuredClone(this.state));
      return value;
    } catch (error) {
      this.state.failedStep ??= key;
      await this.persist?.(structuredClone(this.state));
      throw error;
    }
  }
}
