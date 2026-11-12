import { beforeEach, expect, it, vi } from "vitest";
import { runConsensus } from "@polyvise/core/consensus/engine";
import { runAdvisoryPanel } from "@polyvise/core/panel/engine";
import type { RunCheckpoint } from "@polyvise/core/runs/checkpoint";
import { loadDebateRuntimeConfig } from "@polyvise/core/debate/config";
import { MockLlmProvider, type LlmRequest } from "@polyvise/core/providers/llm";

const search = vi.hoisted(() => vi.fn());
vi.mock("@polyvise/core/providers/search", () => ({ collectEvidenceWithDiagnostics: search }));
beforeEach(() => search.mockReset().mockResolvedValue({ sources: [] }));
const config = { ...loadDebateRuntimeConfig({}), allowDeterministicFallbacks: false };

it.each([
  ["consensus", 1], ["consensus", 3], ["consensus", 6], ["consensus", 8],
  ["advisory_panel", 1], ["advisory_panel", 3], ["advisory_panel", 5]
] as const)("resumes %s at operation %i, preserving every completed contribution", async (mode, failAt) => {
  const run = mode === "consensus" ? runConsensus : runAdvisoryPanel;
  const request = { subject: "Should we use a four-day work week?", mode, consensus: { agentCount: 3, rounds: 2 } };
  let checkpoint: RunCheckpoint | undefined;
  let calls = 0;
  class Provider extends MockLlmProvider {
    async generateStructured<T>(input: LlmRequest) {
      calls++;
      if (calls === failAt) throw new Error("Provider timed out");
      return super.generateStructured<T>(input);
    }
  }
  const options = { config, provider: new Provider(), onCheckpoint: (value: RunCheckpoint) => { checkpoint = JSON.parse(JSON.stringify(value)); } };
  await expect(run("resume", request, undefined, options)).rejects.toThrow("timed out");
  const before = structuredClone(checkpoint!);
  const result = await run("resume", request, undefined, { ...options, checkpoint });
  expect(calls).toBe((mode === "consensus" ? 8 : 5) + 1);
  expect(result.id).toBe(before.runId);
  expect(result.startedAt).toBe(before.startedAt);
  expect(search).toHaveBeenCalledTimes(1);
  const contributions = result.result.mode === "consensus"
    ? result.result.rounds.flatMap(round => round.positions) : result.result.advice;
  for (const [key, cached] of Object.entries(before.completed)) {
    if (key.startsWith("position:")) expect(contributions).toContainEqual((cached.value as { position: unknown }).position);
    if (key.startsWith("advice:")) expect(contributions).toContainEqual((cached.value as { entry: unknown }).entry);
  }
  expect(new Set(contributions.map(item => item.id)).size).toBe(contributions.length);
  expect(result.status).toBe("complete");
  await expect(run("different", request, undefined, { ...options, checkpoint })).rejects.toThrow("different debate");
});

it("stops before more model calls if checkpoint persistence fails", async () => {
  const provider = new MockLlmProvider();
  const generate = vi.spyOn(provider, "generateStructured");
  await expect(runAdvisoryPanel("save", { subject: "Should we expand?" }, undefined, {
    config, provider, onCheckpoint: () => { throw new Error("Storage unavailable"); }
  })).rejects.toThrow("Storage unavailable");
  expect(generate).not.toHaveBeenCalled();
});
