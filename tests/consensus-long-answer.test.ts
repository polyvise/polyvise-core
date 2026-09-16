import { expect, it } from "vitest";
import { runConsensus } from "@polyvise/core/consensus/engine";
import { loadDebateRuntimeConfig } from "@polyvise/core/debate/config";
import { MockLlmProvider, type LlmRequest } from "@polyvise/core/providers/llm";

it("reaches the summary model with long participant answers and preserves them", async () => {
  const answer = "Reliable service and replacement funding must be secured. ".repeat(30);
  let summaryCalled = false;
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
        data.finalAnswer = "Prioritize reliable service and secure replacement funding.";
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
  expect(run.result.convergence.finalAnswer).toBe("Prioritize reliable service and secure replacement funding.");
});
