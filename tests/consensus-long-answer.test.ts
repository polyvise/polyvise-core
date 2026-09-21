import { expect, it } from "vitest";
import { runConsensus } from "@polyvise/core/consensus/engine";
import { loadDebateRuntimeConfig } from "@polyvise/core/debate/config";
import { MockLlmProvider, type LlmRequest } from "@polyvise/core/providers/llm";

it("reaches the summary model with long participant answers and preserves them", async () => {
  const answer = "Reliable service and replacement funding must be secured. ".repeat(30);
  let summaryCalled = false;
  const longSummary = "Preserve service quality, funding, and access across all neighborhoods. ".repeat(12);
  class LongAnswerProvider extends MockLlmProvider {
    async generateStructured<T>(request: LlmRequest) {
      const response = await super.generateStructured<T>(request);
      if (request.schemaName === "consensusPositionOutput") {
        const data = response.data as { positions: { answer: string }[] };
        for (const position of data.positions) position.answer = answer;
      }
      if (request.schemaName === "consensusSummaryOutput") {
        summaryCalled = true;
        const data = response.data as { finalAnswer: string };
        expect(data.finalAnswer.length).toBeLessThanOrEqual(400);
        Object.assign(data, { headline: longSummary, finding: longSummary, finalAnswer: longSummary, range: longSummary });
      }
      return response;
    }
  }
  const run = await runConsensus(
    "long-answer-regression",
    { subject: "Should cities make public transit free?", mode: "consensus", consensus: { agentCount: 3, rounds: 2 } },
    undefined,
    { provider: new LongAnswerProvider(), config: { ...loadDebateRuntimeConfig(), enableMockLlm: true, evidenceProvider: "mock", allowDeterministicFallbacks: true } },
  );
  expect(summaryCalled).toBe(true);
  expect(run.status).toBe("complete");
  expect(run.result.rounds.at(-1)?.positions[0].answer).toBe(answer);
  expect(run.result.convergence.finalAnswer).toBe(longSummary);
  expect(run.result.convergence.range).toBe(longSummary);
  expect(run.result.summary.finding).toBe(longSummary);
  expect(run.result.summary.headline).toBe(longSummary);
});

it("still rejects missing or incorrectly typed summary fields", async () => {
  const { consensusSummaryOutputSchema } = await import("@polyvise/core/consensus/schema");
  const valid = { headline: "Summary", finding: "Finding", finalAnswer: "Answer", range: "Range" };
  expect(consensusSummaryOutputSchema.safeParse(valid).success).toBe(true);
  expect(consensusSummaryOutputSchema.safeParse({ ...valid, finding: "" }).success).toBe(false);
  expect(consensusSummaryOutputSchema.safeParse({ ...valid, range: 42 }).success).toBe(false);
  expect(consensusSummaryOutputSchema.safeParse({ ...valid, finalAnswer: undefined }).success).toBe(false);
});
