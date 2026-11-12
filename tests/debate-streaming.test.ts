import { describe, expect, it, vi } from "vitest";
import { runHybridCouncilDebate } from "@polyvise/core/debate/engine";
import { loadDebateRuntimeConfig } from "@polyvise/core/debate/config";
import { MockLlmProvider, type LlmRequest } from "@polyvise/core/providers/llm";
import type { DebateLiveEvent } from "@polyvise/core/debate/types";

vi.mock("@polyvise/core/providers/search", () => ({
  collectEvidenceWithDiagnostics: async () => ({
    sources: [{
      id: "recess-study", title: "Recess and classroom attention", url: "https://example.edu/recess",
      publisher: "School research team", snippet: "A planned break can help students return to lessons.",
      quality: "expert", retrievedVia: "tavily", status: "accepted"
    }]
  })
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

type TurnEvent = Extract<DebateLiveEvent, { kind: "turns" }>;
const request = { subject: "Should schools have longer recess?", councilSize: "duo" as const };
const config = { ...loadDebateRuntimeConfig({}), maxRounds: 4 };

describe("speaker turn delivery", () => {
  it.each([true, false])("streams only when opted in (streamTurns: %s)", async (streamTurns) => {
    const conStarted = deferred();
    const releaseCon = deferred();
    const events: TurnEvent[] = [];
    class DelayedConProvider extends MockLlmProvider {
      async generateStructured<T>(input: LlmRequest) {
        if (input.role === "con advocate opening round") {
          conStarted.resolve();
          await releaseCon.promise;
        }
        return super.generateStructured<T>(input);
      }
    }
    const completed = runHybridCouncilDebate("streamed-debate", request, undefined, {
      provider: new DelayedConProvider(), config, streamTurns,
      emit: (event) => { if (event.kind === "turns") events.push(event); }
    });
    await conStarted.promise;
    try {
      expect(events).toHaveLength(streamTurns ? 1 : 0);
      if (streamTurns) {
        expect(events[0].round).toBe("opening");
        expect(events[0].turns.map((turn) => turn.side)).toEqual(["pro"]);
      }
    } finally {
      releaseCon.resolve();
    }
    const run = await completed;
    const streamed = events.flatMap((event) => event.turns);
    expect(streamed).toEqual(run.turns);
    expect(new Set(streamed.map((turn) => turn.id)).size).toBe(run.turns.length);
    expect(events.filter((event) => event.round === "opening")).toHaveLength(streamTurns ? 2 : 1);
  });

  it("marks only the failed speaker's event as a placeholder", async () => {
    const events: TurnEvent[] = [];
    class FailedConProvider extends MockLlmProvider {
      async generateStructured<T>(input: LlmRequest) {
        if (input.role === "con advocate opening round") throw new Error("Con model unavailable");
        return super.generateStructured<T>(input);
      }
    }
    const run = await runHybridCouncilDebate("partial-batch", request, undefined, {
      provider: new FailedConProvider(), config, streamTurns: true,
      emit: (event) => { if (event.kind === "turns") events.push(event); }
    });
    const opening = events.filter((event) => event.round === "opening");
    expect(opening[0].placeholder).toBeUndefined();
    expect(opening[1].placeholder?.reason).toContain("Con model unavailable");
    expect(run.placeholders?.turns?.opening).toEqual(opening[1].placeholder);
    expect(events.flatMap((event) => event.turns)).toEqual(run.turns);
  });

  it("keeps a delivered YES statement available if NO fails without fallback", async () => {
    const events: TurnEvent[] = [];
    class FailedConProvider extends MockLlmProvider {
      async generateStructured<T>(input: LlmRequest) {
        if (input.role === "con advocate opening round") throw new Error("Con model unavailable");
        return super.generateStructured<T>(input);
      }
    }
    await expect(runHybridCouncilDebate("failed-batch", request, undefined, {
      provider: new FailedConProvider(),
      config: { ...config, allowDeterministicFallbacks: false }, streamTurns: true,
      emit: (event) => { if (event.kind === "turns") events.push(event); }
    })).rejects.toThrow("Con model unavailable");
    expect(events).toHaveLength(1);
    expect(events[0].turns[0].side).toBe("pro");
  });
});
