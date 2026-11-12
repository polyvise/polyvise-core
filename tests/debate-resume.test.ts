import { beforeEach, describe, expect, it, vi } from "vitest";
import { runHybridCouncilDebate, type DebateCheckpoint } from "@polyvise/core/debate/engine";
import { loadDebateRuntimeConfig } from "@polyvise/core/debate/config";
import { MockLlmProvider, type LlmRequest } from "@polyvise/core/providers/llm";
import type { DebateLiveEvent } from "@polyvise/core/debate/types";

const search = vi.hoisted(() => vi.fn());
vi.mock("@polyvise/core/providers/search", () => ({ collectEvidenceWithDiagnostics: search }));
const request = { subject: "Should schools have longer recess?", councilSize: "duo" as const };
const config = { ...loadDebateRuntimeConfig({}), maxRounds: 4, allowDeterministicFallbacks: false };

beforeEach(() => {
  search.mockReset().mockResolvedValue({ sources: [{
    id: "source", title: "Recess", url: "https://example.edu/recess", publisher: "School",
    snippet: "A break can help attention.", quality: "expert", retrievedVia: "tavily", status: "accepted"
  }] });
});

describe("durable debate resumption", () => {
  it.each([
    "pro advocate claim builder", "con advocate claim builder", "pro advocate opening round",
    "con advocate opening round", "con advocate closing round", "scorecard judge", "final summary"
  ])("retries only unfinished operations after %s fails", async (failedRole) => {
    let checkpoint: DebateCheckpoint | undefined;
    const calls: string[] = [];
    const delivered: DebateLiveEvent[] = [];
    let fail = true;
    class Provider extends MockLlmProvider {
      async generateStructured<T>(input: LlmRequest) {
        calls.push(input.role);
        if (fail && input.role === failedRole) throw new Error("Model timed out");
        return super.generateStructured<T>(input);
      }
    }
    const options = {
      provider: new Provider(), config, streamTurns: true,
      onCheckpoint: (value: DebateCheckpoint) => { checkpoint = JSON.parse(JSON.stringify(value)); },
      emit: (event: DebateLiveEvent) => { delivered.push(event); }
    };
    await expect(runHybridCouncilDebate("resume", request, undefined, options)).rejects.toThrow("timed out");
    const completedCalls = calls.slice(0, -1);
    const oldTurns = delivered.flatMap((event) => event.kind === "turns" ? event.turns : []);
    const original = structuredClone(checkpoint!);
    expect(checkpoint?.failedStep).toBeTruthy();
    fail = false;
    calls.length = 0;
    delivered.length = 0;
    const run = await runHybridCouncilDebate("resume", request, undefined, { ...options, provider: new Provider(), checkpoint });
    expect(calls[0]).toBe(failedRole);
    for (const role of completedCalls) expect(calls).not.toContain(role);
    expect(search).toHaveBeenCalledTimes(1);
    expect(run.id).toBe(original.runId);
    expect(run.startedAt).toBe(original.startedAt);
    expect(run.turns.slice(0, oldTurns.length)).toEqual(oldTurns);
    expect(delivered.flatMap((event) => event.kind === "turns" ? event.turns : [])).toEqual(run.turns);
    expect(run.status).toBe("complete");
  });

  it("retries evidence gathering without regenerating the teams", async () => {
    search.mockRejectedValueOnce(new Error("Search timed out"));
    let checkpoint: DebateCheckpoint | undefined;
    const options = { config, provider: new MockLlmProvider(), onCheckpoint: (value: DebateCheckpoint) => { checkpoint = value; } };
    await expect(runHybridCouncilDebate("search", request, undefined, options)).rejects.toThrow("Search timed out");
    const teams = checkpoint?.completed.teams.value;
    const run = await runHybridCouncilDebate("search", request, undefined, { ...options, checkpoint });
    expect(search).toHaveBeenCalledTimes(2);
    expect(run.teams).toEqual(teams);
  });

  it("rejects checkpoints for another question or debate before making calls", async () => {
    let checkpoint: DebateCheckpoint | undefined;
    await runHybridCouncilDebate("original", request, undefined, {
      config, provider: new MockLlmProvider(), onCheckpoint: (value) => { checkpoint = value; }
    });
    search.mockClear();
    await expect(runHybridCouncilDebate("other", request, undefined, { config, checkpoint })).rejects.toThrow("different debate");
    await expect(runHybridCouncilDebate("original", { ...request, subject: "Another question?" }, undefined, { config, checkpoint })).rejects.toThrow("different debate");
    expect(search).not.toHaveBeenCalled();
  });
});
