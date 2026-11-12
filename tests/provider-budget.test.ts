import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { OpenRouterLlmProvider, LlmProviderFailure } from "@polyvise/core/providers/llm";
import { generateStructured } from "@polyvise/core/runs/execution";
import { loadDebateRuntimeConfig } from "@polyvise/core/debate/config";

const config = { ...loadDebateRuntimeConfig({}), llmMaxAttempts: 3, llmTimeoutMs: 20, llmMaxTokens: 8192, apiRetryBaseDelayMs: 1, useStrictJsonSchema: true, allowDeterministicFallbacks: false };
const schema = z.object({ answer: z.string().min(1) });
const reply = (content: string, finish_reason = "stop") => Response.json({ choices: [{ finish_reason, message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.01 } });
const error = (status: number, message = "unavailable", headers = {}) => Response.json({ error: { message } }, { status, headers });
const provider = () => new OpenRouterLlmProvider(config, "test-key");
const generate = () => generateStructured(provider(), "test", "answer", { answer: "fallback" }, schema, config, "Answer the question.");
beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

it.each([400, 401, 402, 403, 404])("does not retry permanent HTTP %i errors in another format", async status => {
  const fetcher = vi.fn(async () => error(status));
  vi.stubGlobal("fetch", fetcher);
  await expect(generate()).rejects.toBeInstanceOf(LlmProviderFailure);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("shares three calls across transport errors, validation and repair, retaining all usage", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(error(503)).mockResolvedValueOnce(reply('{"answer":4}')).mockResolvedValueOnce(reply('{"answer":"Fixed"}'));
  vi.stubGlobal("fetch", fetcher);
  const result = await generate();
  expect(fetcher).toHaveBeenCalledTimes(3);
  const repair = JSON.parse(fetcher.mock.calls[2][1].body).messages[1].content;
  expect(repair).toContain('Rejected output: {"answer":4}');
  expect(repair).toContain("Validation errors:");
  expect(result.snapshot.attempts?.map(a => a.status)).toEqual(["failed", "failed", "ok"]);
  expect(result.snapshot.promptTokens).toBe(20);
  expect(result.snapshot.estimatedCostUsd).toBeCloseTo(0.02);
});

it("does not multiply budgets when repeated output validation fails", async () => {
  const fetcher = vi.fn(async () => reply('{"answer":4}'));
  vi.stubGlobal("fetch", fetcher);
  const failure = await generate().catch(e => e as LlmProviderFailure);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(failure.snapshot.attempts).toHaveLength(3);
  expect(failure.snapshot.completionTokens).toBe(15);
});

it("switches format only for schema support errors and keeps the same budget", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(error(400, "json_schema is not supported")).mockResolvedValueOnce(reply('{"answer":4}')).mockResolvedValueOnce(reply('{"answer":"Fixed"}'));
  vi.stubGlobal("fetch", fetcher);
  const result = await generate();
  expect(result.snapshot.attempts).toHaveLength(3);
  expect(JSON.parse(fetcher.mock.calls[1][1].body).response_format.type).toBe("json_object");
});

it("grows output room only for truncation and records malformed-response costs", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply('{"answer":', "length")).mockResolvedValueOnce(reply('{"answer":')).mockResolvedValueOnce(reply('{"answer":"Fixed"}'));
  vi.stubGlobal("fetch", fetcher);
  const result = await generate();
  expect(fetcher.mock.calls.map(call => JSON.parse(call[1].body).max_tokens)).toEqual([8192, 16384, 16384]);
  expect(result.snapshot.estimatedCostUsd).toBeCloseTo(0.03);
});

it("stops instead of hammering a provider with a long Retry-After", async () => {
  const fetcher = vi.fn(async () => error(429, "wait", { "Retry-After": "60" }));
  vi.stubGlobal("fetch", fetcher);
  await expect(generate()).rejects.toThrow("wait");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("bounds timed-out requests without restarting in another format", async () => {
  vi.stubGlobal("fetch", vi.fn((_url: string, options: RequestInit) => new Promise((_, reject) => {
    options.signal?.addEventListener("abort", () => reject(new DOMException("Timed out", "AbortError")));
  })));
  await expect(generate()).rejects.toThrow("timed out");
  expect(fetch).toHaveBeenCalledTimes(3);
});
