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
  it("requests brief turns for every speaker and round without cutting a longer model response", async () => {
    const prompts: Array<{ round: string; rules: string[]; expectedTurns: Array<{ side: string }> }> = [];
    const longAnswer = "I support more recess because students need time to move, rest, and talk with friends. ".repeat(8).trim();
    class PromptCaptureProvider extends MockLlmProvider {
      async generateStructured<T>(input: LlmRequest) {
        if (input.schemaName === "debateTurnOutput") {
          prompts.push(JSON.parse(input.prompt));
          if (input.role === "pro advocate opening round") {
            const fallback = structuredClone(input.fallback) as { turns: Array<{ content: string }> };
            fallback.turns[0].content = longAnswer;
            return super.generateStructured<T>({ ...input, fallback });
          }
        }
        return super.generateStructured<T>(input);
      }
    }
    const run = await runHybridCouncilDebate("brief-turns", request, undefined, {
      provider: new PromptCaptureProvider(), config, streamTurns: true
    });
    expect(prompts).toHaveLength(9);
    for (const prompt of prompts) {
      expect(prompt.rules.join(" ")).toContain("30-60 words");
      expect(prompt.rules.join(" ")).toContain("never truncate");
      expect(prompt.rules.join(" ")).not.toContain("35 to 100 words");
      if (prompt.round === "cross_examination") {
        expect(prompt.rules.join(" ")).toContain("15-35 words");
        expect(prompt.rules.join(" ")).toContain("exactly one");
      }
    }
    expect(run.turns.find((turn) => turn.round === "opening" && turn.side === "pro")?.content).toBe(longAnswer);
  });

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
