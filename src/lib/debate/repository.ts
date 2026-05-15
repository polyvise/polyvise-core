import type { DebateRecord } from "./types";

export interface DebateRepository {
  save(debate: DebateRecord): void;
  get(id: string): DebateRecord | null;
  list(): DebateRecord[];
}

type MemoryRepositoryState = {
  debates: Map<string, DebateRecord>;
};

const globalForRepository = globalThis as typeof globalThis & {
  __polyviseDebateRepository?: MemoryRepositoryState;
};

export class MemoryDebateRepository implements DebateRepository {
  private readonly state: MemoryRepositoryState;

  constructor(
    state =
      globalForRepository.__polyviseDebateRepository ??
      (globalForRepository.__polyviseDebateRepository = {
        debates: new Map()
      })
  ) {
    this.state = state;
  }

  save(debate: DebateRecord): void {
    this.state.debates.set(debate.id, debate);
  }

  get(id: string): DebateRecord | null {
    return this.state.debates.get(id) ?? null;
  }

  list(): DebateRecord[] {
    return Array.from(this.state.debates.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

export function createDefaultDebateRepository(): DebateRepository {
  return new MemoryDebateRepository();
}
