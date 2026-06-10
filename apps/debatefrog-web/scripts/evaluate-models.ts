import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type EvidenceProviderName,
  loadDebateRuntimeConfig,
  modelOptionsFromConfig,
  OpenRouterLlmProvider,
  runHybridCouncilDebate,
  type DebateRun,
  type ModelSnapshot
} from "@polyvise/debate-engine";

type EvalQuestion = {
  id: string;
  question: string;
  tags: string[];
  why: string;
};

type ModelEvalRun = {
  questionId: string;
  question: string;
  status: "ok" | "failed";
  quality: number | null;
  heuristicQuality: number | null;
  llmQuality: number | null;
  latencyMs: number | null;
  costUsd: number | null;
  retryCount: number;
  llmJudgeModel: string | null;
  llmJudgeCostUsd: number | null;
  llmJudgeLatencyMs: number | null;
  llmJudgeRetryCount: number;
  llmJudgeRationale: string | null;
  llmJudgeStrengths: string[];
  llmJudgeWeaknesses: string[];
  secondJudgeModel: string | null;
  secondJudgeQuality: number | null;
  secondJudgeCostUsd: number | null;
  secondJudgeLatencyMs: number | null;
  secondJudgeRetryCount: number;
  secondJudgeRationale: string | null;
  secondJudgeReason: string | null;
  failureReason: string | null;
  dimensions: Record<string, number> | null;
};

type ModelEvalSummary = {
  id: string;
  label: string;
  provider: string;
  evaluated: boolean;
  questionCount: number;
  averageQuality: number | null;
  averageHeuristicQuality: number | null;
  averageLlmQuality: number | null;
  averageSecondJudgeQuality: number | null;
  averageLatencyMs: number | null;
  latencyP50Ms: number | null;
  latencyP90Ms: number | null;
  averageCostUsd: number | null;
  successRate: number | null;
  retryRate: number | null;
  failureCount: number | null;
  dimensions: Record<string, number> | null;
  notes: string;
  runs: ModelEvalRun[];
};

type ModelEvalReport = {
  schemaVersion: 2;
  status: "complete" | "partial";
  generatedAt: string;
  questionSet: {
    path: string;
    count: number;
  };
  summary: {
    bestQualityModelId: string | null;
    fastestModelId: string | null;
    lowestCostModelId: string | null;
    notes: string[];
  };
  evaluation: {
    qualityMethod: string;
    llmJudgeModel: string | null;
    llmJudgeWeight: number;
    secondJudgeModel: string | null;
    secondJudgeMode: "off" | "auto" | "always";
    estimatedSpendUsd: number | null;
    budgetUsd: number | null;
  };
  models: ModelEvalSummary[];
};

type QualityJudgeOutput = {
  overallQuality: number;
  dimensions: {
    argumentQuality: number;
    evidenceUse: number;
    fairness: number;
    ageAppropriateClarity: number;
    decisiveness: number;
    groundedness: number;
  };
  strengths: string[];
  weaknesses: string[];
  rationale: string;
};

type QualityScore = {
  quality: number;
  heuristicQuality: number;
  llmQuality: number | null;
  dimensions: Record<string, number>;
  llmJudgeModel: string | null;
  llmJudgeCostUsd: number | null;
  llmJudgeLatencyMs: number | null;
  llmJudgeRetryCount: number;
  llmJudgeRationale: string | null;
  llmJudgeStrengths: string[];
  llmJudgeWeaknesses: string[];
  secondJudgeModel: string | null;
  secondJudgeQuality: number | null;
  secondJudgeCostUsd: number | null;
  secondJudgeLatencyMs: number | null;
  secondJudgeRetryCount: number;
  secondJudgeRationale: string | null;
  secondJudgeReason: string | null;
};

type CachedDebateRunArtifact = {
  schemaVersion: 1;
  generatedAt: string;
  modelId: string;
  questionId: string;
  question: string;
  run: DebateRun;
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "../../..");
const appDir = path.resolve(scriptDir, "..");
const questionsPath = path.join(appDir, "evals/questions.json");
const resultsDir = path.join(appDir, "evals/results");
const artifactsDir = path.join(appDir, "evals/artifacts/debate-runs");
const qualityJudgeOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    overallQuality: { type: "number", minimum: 0, maximum: 100 },
    dimensions: {
      type: "object",
      additionalProperties: false,
      properties: {
        argumentQuality: { type: "number", minimum: 0, maximum: 100 },
        evidenceUse: { type: "number", minimum: 0, maximum: 100 },
        fairness: { type: "number", minimum: 0, maximum: 100 },
        ageAppropriateClarity: { type: "number", minimum: 0, maximum: 100 },
        decisiveness: { type: "number", minimum: 0, maximum: 100 },
        groundedness: { type: "number", minimum: 0, maximum: 100 }
      },
      required: [
        "argumentQuality",
        "evidenceUse",
        "fairness",
        "ageAppropriateClarity",
        "decisiveness",
        "groundedness"
      ]
    },
    strengths: { type: "array", items: { type: "string" }, maxItems: 3 },
    weaknesses: { type: "array", items: { type: "string" }, maxItems: 3 },
    rationale: { type: "string" }
  },
  required: ["overallQuality", "dimensions", "strengths", "weaknesses", "rationale"]
} satisfies Record<string, unknown>;

async function main() {
  const config = {
    ...loadDebateRuntimeConfig(),
    evidenceProvider: evalEvidenceProvider(),
    enableMockLlm: false,
    allowDeterministicFallbacks: false,
    llmMaxAttempts: positiveInteger(process.env.POLYVISE_EVAL_LLM_MAX_ATTEMPTS, 2),
    llmTimeoutMs: positiveInteger(process.env.POLYVISE_EVAL_LLM_TIMEOUT_MS, 25000)
  };
  const useLlmJudge = process.env.POLYVISE_EVAL_USE_LLM_JUDGE !== "false";
  const llmJudgeModel = useLlmJudge ? process.env.POLYVISE_EVAL_JUDGE_MODEL || "openai/gpt-5.5" : null;
  const llmJudgeWeight = useLlmJudge
    ? clamp(positiveNumber(process.env.POLYVISE_EVAL_LLM_JUDGE_WEIGHT, 0.8), 0, 1)
    : 0;
  const secondJudgeMode = llmJudgeModel ? parseSecondJudgeMode(process.env.POLYVISE_EVAL_SECOND_JUDGE_MODE) : "off";
  const secondJudgeModel =
    llmJudgeModel && secondJudgeMode !== "off"
      ? process.env.POLYVISE_EVAL_SECOND_JUDGE_MODEL || "anthropic/claude-opus-4.7"
      : null;
  const budgetUsd = positiveNumber(process.env.POLYVISE_EVAL_BUDGET_USD, 25);
  const enforceBudget = coerceBoolean(process.env.POLYVISE_EVAL_ENFORCE_BUDGET, false);
  const reuseDebateArtifacts = coerceBoolean(process.env.POLYVISE_EVAL_REUSE_DEBATE_ARTIFACTS, false);
  const requireDebateArtifacts = coerceBoolean(process.env.POLYVISE_EVAL_REQUIRE_DEBATE_ARTIFACTS, false);
  const qualityJudge = llmJudgeModel
    ? new OpenRouterLlmProvider(
        {
          ...config,
          quickModel: llmJudgeModel,
          deepModel: llmJudgeModel,
          yesModel: llmJudgeModel,
          noModel: llmJudgeModel,
          judgeModel: llmJudgeModel,
          llmMaxAttempts: positiveInteger(process.env.POLYVISE_EVAL_JUDGE_MAX_ATTEMPTS, 2),
          llmTimeoutMs: positiveInteger(process.env.POLYVISE_EVAL_JUDGE_TIMEOUT_MS, 45000),
          llmMaxTokens: positiveInteger(process.env.POLYVISE_EVAL_JUDGE_MAX_TOKENS, 900)
        },
        process.env.OPENROUTER_API_KEY
      )
    : null;
  const secondQualityJudge = secondJudgeModel
    ? new OpenRouterLlmProvider(
        {
          ...config,
          quickModel: secondJudgeModel,
          deepModel: secondJudgeModel,
          yesModel: secondJudgeModel,
          noModel: secondJudgeModel,
          judgeModel: secondJudgeModel,
          llmMaxAttempts: positiveInteger(process.env.POLYVISE_EVAL_SECOND_JUDGE_MAX_ATTEMPTS, 2),
          llmTimeoutMs: positiveInteger(process.env.POLYVISE_EVAL_SECOND_JUDGE_TIMEOUT_MS, 45000),
          llmMaxTokens: positiveInteger(process.env.POLYVISE_EVAL_SECOND_JUDGE_MAX_TOKENS, 900)
        },
        process.env.OPENROUTER_API_KEY
      )
    : null;
  const questions = selectedQuestions(JSON.parse(await readFile(questionsPath, "utf8")) as EvalQuestion[]);
  const roster = modelOptionsFromConfig(config).options;
  const selectedModelIds = selectedModels(roster.map((model) => model.id));
  let estimatedSpendUsd = 0;

  console.log(`Evaluating ${selectedModelIds.length} model(s) across ${questions.length} question(s).`);
  console.log(
    config.evidenceProvider === "mock"
      ? "This uses live AI model calls with fixed evidence for fair model comparison."
      : `This uses live AI model calls and live ${config.evidenceProvider} search.`
  );
  console.log(
    qualityJudge
      ? `Quality scoring uses ${llmJudgeModel} as the primary LLM judge (${Math.round(llmJudgeWeight * 100)}%) plus deterministic heuristics. Second judge: ${secondJudgeModel ? `${secondJudgeModel} (${secondJudgeMode})` : "off"}. Estimated spend will be tracked${enforceBudget ? ` with a $${budgetUsd.toFixed(2)} hard cap` : ""}.`
      : "Quality scoring uses deterministic heuristics only."
  );
  console.log(
    `Debate run artifacts will be saved under ${path.relative(rootDir, artifactsDir)}${
      reuseDebateArtifacts ? " and reused when present" : ""
    }${requireDebateArtifacts ? "; missing artifacts will fail the run" : ""}.`
  );

  const models: ModelEvalSummary[] = [];
  let stoppedEarlyReason: string | null = null;

  for (const modelId of selectedModelIds) {
    const label = roster.find((model) => model.id === modelId)?.label ?? labelForModel(modelId);

    if (stoppedEarlyReason) {
      models.push(unevaluatedModel(modelId, label, questions.length, stoppedEarlyReason));
      continue;
    }

    console.log(`\n== ${label} ==`);
    const runs: ModelEvalRun[] = [];

    for (const question of questions) {
      if (enforceBudget && estimatedSpendUsd >= budgetUsd) {
        stoppedEarlyReason = `Evaluation budget reached ($${estimatedSpendUsd.toFixed(2)} of $${budgetUsd.toFixed(2)}).`;
        break;
      }

      process.stdout.write(`- ${question.id} ... `);
      try {
        const cachedRun = reuseDebateArtifacts || requireDebateArtifacts
          ? await loadCachedDebateRun(modelId, question.id)
          : null;
        if (requireDebateArtifacts && !cachedRun) {
          throw new Error(`Missing cached debate artifact for ${modelId} / ${question.id}.`);
        }
        const run = cachedRun ?? await generateDebateRun({
          config,
          modelId,
          question
        });
        if (!cachedRun) {
          await saveDebateRunArtifact({ modelId, question, run });
        }
        const scored = await scoreRun({
          run,
          question,
          modelId,
          qualityJudge,
          llmJudgeModel,
          llmJudgeWeight,
          secondQualityJudge,
          secondJudgeModel,
          secondJudgeMode
        });
        estimatedSpendUsd += totalCost(run.modelSnapshots) + (scored.llmJudgeCostUsd ?? 0) + (scored.secondJudgeCostUsd ?? 0);
        runs.push({
          questionId: question.id,
          question: question.question,
          status: "ok",
          quality: scored.quality,
          heuristicQuality: scored.heuristicQuality,
          llmQuality: scored.llmQuality,
          latencyMs: totalLatency(run.modelSnapshots),
          costUsd: totalCost(run.modelSnapshots),
          retryCount: retryCount(run.modelSnapshots),
          llmJudgeModel: scored.llmJudgeModel,
          llmJudgeCostUsd: scored.llmJudgeCostUsd,
          llmJudgeLatencyMs: scored.llmJudgeLatencyMs,
          llmJudgeRetryCount: scored.llmJudgeRetryCount,
          llmJudgeRationale: scored.llmJudgeRationale,
          llmJudgeStrengths: scored.llmJudgeStrengths,
          llmJudgeWeaknesses: scored.llmJudgeWeaknesses,
          secondJudgeModel: scored.secondJudgeModel,
          secondJudgeQuality: scored.secondJudgeQuality,
          secondJudgeCostUsd: scored.secondJudgeCostUsd,
          secondJudgeLatencyMs: scored.secondJudgeLatencyMs,
          secondJudgeRetryCount: scored.secondJudgeRetryCount,
          secondJudgeRationale: scored.secondJudgeRationale,
          secondJudgeReason: scored.secondJudgeReason,
          failureReason: null,
          dimensions: scored.dimensions
        });
        console.log(`${Math.round(scored.quality)}/100${cachedRun ? " (cached debate)" : ""}`);
      } catch (error) {
        const reason = summarizeFailure(error);
        runs.push({
          questionId: question.id,
          question: question.question,
          status: "failed",
          quality: null,
          heuristicQuality: null,
          llmQuality: null,
          latencyMs: null,
          costUsd: null,
          retryCount: 0,
          llmJudgeModel: null,
          llmJudgeCostUsd: null,
          llmJudgeLatencyMs: null,
          llmJudgeRetryCount: 0,
          llmJudgeRationale: null,
          llmJudgeStrengths: [],
          llmJudgeWeaknesses: [],
          secondJudgeModel: null,
          secondJudgeQuality: null,
          secondJudgeCostUsd: null,
          secondJudgeLatencyMs: null,
          secondJudgeRetryCount: 0,
          secondJudgeRationale: null,
          secondJudgeReason: null,
          failureReason: reason,
          dimensions: null
        });
        console.log(`failed: ${reason}`);
        if (shouldStopRun(reason)) {
          stoppedEarlyReason = reason;
          break;
        }
      }
    }

    models.push(summarizeModel(modelId, label, runs));
  }

  const generatedAt = new Date().toISOString();
  const report = await maybeMergeWithLatest({
    schemaVersion: 2,
    status: models.some((model) => (model.failureCount ?? 0) > 0) ? "partial" : "complete",
    generatedAt,
    questionSet: {
      path: "apps/debatefrog-web/evals/questions.json",
      count: questions.length
    },
    summary: {
      bestQualityModelId: bestBy(models, "averageQuality", "desc"),
      fastestModelId: bestBy(models, "averageLatencyMs", "asc"),
      lowestCostModelId: bestBy(models, "averageCostUsd", "asc"),
      notes: [
        qualityJudge
          ? "Quality is a blended score from a rubric-based LLM judge and deterministic structured-output checks."
          : "Quality is a heuristic score from structured Debatefrog outputs, not a human gold-standard rating.",
        config.evidenceProvider === "mock"
          ? "This run used fixed evidence so model quality comparisons are not confounded by web search rate limits or changing search results."
          : `This run used live ${config.evidenceProvider} search, so evidence availability may affect model scores.`,
        qualityJudge
          ? `Quality is ${Math.round(llmJudgeWeight * 100)}% LLM judge (${llmJudgeModel}${secondJudgeModel ? `, with ${secondJudgeModel} second opinions in ${secondJudgeMode} mode` : ""}) and ${Math.round((1 - llmJudgeWeight) * 100)}% deterministic rubric.`
          : "Quality is a deterministic rubric score from structured Debatefrog outputs.",
        "Latency is noisy and depends on time of day, provider routing, network conditions, retries, and prompt difficulty.",
        "Run this evaluation quarterly or after changing model options, prompts, or judging criteria.",
        ...(stoppedEarlyReason ? [`This run stopped early: ${stoppedEarlyReason}`] : [])
      ]
    },
    evaluation: {
      qualityMethod: qualityJudge
        ? `${Math.round(llmJudgeWeight * 100)}% LLM judge + ${Math.round((1 - llmJudgeWeight) * 100)}% deterministic heuristic`
        : "deterministic heuristic",
      llmJudgeModel,
      llmJudgeWeight,
      secondJudgeModel,
      secondJudgeMode,
      estimatedSpendUsd,
      budgetUsd
    },
    models
  });

  await mkdir(resultsDir, { recursive: true });
  const stamp = generatedAt.replace(/[:.]/g, "-");
  await writeFile(path.join(resultsDir, "latest.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(path.join(resultsDir, `model-quality-${stamp}.json`), JSON.stringify(report, null, 2) + "\n");
  const csv = toCsv(report);
  await writeFile(path.join(resultsDir, "latest.csv"), csv);
  await writeFile(path.join(resultsDir, `model-quality-${stamp}.csv`), csv);

  console.log(`\nWrote ${path.relative(rootDir, path.join(resultsDir, "latest.json"))}`);
  console.log(`Wrote ${path.relative(rootDir, path.join(resultsDir, "latest.csv"))}`);
}

async function generateDebateRun({
  config,
  modelId,
  question
}: {
  config: ReturnType<typeof loadDebateRuntimeConfig>;
  modelId: string;
  question: EvalQuestion;
}) {
  const modelConfig = {
    ...config,
    quickModel: modelId,
    deepModel: modelId,
    yesModel: modelId,
    noModel: modelId,
    judgeModel: modelId
  };
  return runHybridCouncilDebate(
    `eval_${question.id}_${slug(modelId)}`,
    {
      subject: question.question,
      mode: "hybrid_council",
      evidence: "cited",
      councilSize: "duo",
      models: {
        yes: modelId,
        no: modelId,
        judge: modelId
      }
    },
    undefined,
    { config: modelConfig }
  );
}

async function saveDebateRunArtifact({
  modelId,
  question,
  run
}: {
  modelId: string;
  question: EvalQuestion;
  run: DebateRun;
}) {
  const artifact: CachedDebateRunArtifact = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    modelId,
    questionId: question.id,
    question: question.question,
    run
  };
  const filePath = debateRunArtifactPath(modelId, question.id);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(artifact, null, 2) + "\n");
}

async function loadCachedDebateRun(modelId: string, questionId: string): Promise<DebateRun | null> {
  try {
    const artifact = JSON.parse(await readFile(debateRunArtifactPath(modelId, questionId), "utf8")) as CachedDebateRunArtifact;
    return artifact.run;
  } catch {
    return null;
  }
}

function debateRunArtifactPath(modelId: string, questionId: string) {
  return path.join(artifactsDir, questionId, `${slug(modelId)}.json`);
}

function selectedModels(defaultModelIds: string[]) {
  const requested = process.env.POLYVISE_EVAL_MODELS?.split(",").map((item) => item.trim()).filter(Boolean);
  return requested?.length ? requested : defaultModelIds;
}

function selectedQuestions(questions: EvalQuestion[]) {
  const requested = process.env.POLYVISE_EVAL_QUESTIONS?.split(",").map((item) => item.trim()).filter(Boolean);
  if (!requested?.length) return questions;
  const requestedSet = new Set(requested);
  return questions.filter((question) => requestedSet.has(question.id));
}

async function maybeMergeWithLatest(report: ModelEvalReport): Promise<ModelEvalReport> {
  if (process.env.POLYVISE_EVAL_MERGE_LATEST !== "true") {
    return report;
  }

  const latestPath = path.join(resultsDir, "latest.json");
  let previous: ModelEvalReport;
  try {
    previous = JSON.parse(await readFile(latestPath, "utf8")) as ModelEvalReport;
  } catch {
    return report;
  }

  const replacements = new Map(report.models.map((model) => [model.id, model]));
  const mergedModels = previous.models.map((model) => replacements.get(model.id) ?? model);
  for (const model of report.models) {
    if (!previous.models.some((existing) => existing.id === model.id)) {
      mergedModels.push(model);
    }
  }

  return {
    ...report,
    status: mergedModels.some((model) => !model.evaluated || (model.failureCount ?? 0) > 0) ? "partial" : "complete",
    models: mergedModels,
    summary: {
      ...report.summary,
      bestQualityModelId: bestBy(mergedModels, "averageQuality", "desc"),
      fastestModelId: bestBy(mergedModels, "averageLatencyMs", "asc"),
      lowestCostModelId: bestBy(mergedModels, "averageCostUsd", "asc"),
      notes: [
        ...report.summary.notes,
        "This report merges the latest selected-model run into the prior quarterly report."
      ]
    }
  };
}

function evalEvidenceProvider(): EvidenceProviderName {
  const value = process.env.POLYVISE_EVAL_EVIDENCE_PROVIDER;
  if (value === "brave" || value === "tavily" || value === "mock") {
    return value;
  }
  return "mock";
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function coerceBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined) return fallback;
  return value === "true" || value === "1" || value === "yes";
}

function parseSecondJudgeMode(value: string | undefined): "off" | "auto" | "always" {
  if (value === "off" || value === "false" || value === "0") return "off";
  if (value === "always") return "always";
  return "auto";
}

function summarizeFailure(error: unknown) {
  const message = error instanceof Error ? error.message : "Evaluation failed.";
  if (/key limit exceeded|monthly limit|quota/i.test(message)) {
    return "AI provider quota limit exceeded.";
  }
  if (/no endpoints found/i.test(message)) {
    return "AI provider has no endpoint for this model.";
  }
  if (/empty response/i.test(message)) {
    return "AI model returned an empty response.";
  }
  if (message.includes("Structured output validation failed")) {
    if (message.includes('"pro"|"con"|"neutral"')) {
      return "Structured output validation failed: side enum values did not match pro/con/neutral.";
    }
    if (message.includes("conditional_yes") || message.includes("lean_no")) {
      return "Structured output validation failed: judge scorecard did not match the required recommendation schema.";
    }
    return "Structured output validation failed.";
  }
  const withoutProviderUrl = message.replace(/https:\/\/openrouter\.ai\/workspaces\/[^\s"')]+/g, "the provider dashboard");
  return withoutProviderUrl.length > 500 ? `${withoutProviderUrl.slice(0, 500)}...` : withoutProviderUrl;
}

function shouldStopRun(reason: string) {
  return reason === "AI provider quota limit exceeded.";
}

async function scoreRun({
  run,
  question,
  modelId,
  qualityJudge,
  llmJudgeModel,
  llmJudgeWeight,
  secondQualityJudge,
  secondJudgeModel,
  secondJudgeMode
}: {
  run: DebateRun;
  question: EvalQuestion;
  modelId: string;
  qualityJudge: OpenRouterLlmProvider | null;
  llmJudgeModel: string | null;
  llmJudgeWeight: number;
  secondQualityJudge: OpenRouterLlmProvider | null;
  secondJudgeModel: string | null;
  secondJudgeMode: "off" | "auto" | "always";
}): Promise<QualityScore> {
  const allText = [
    ...run.claims.map((claim) => `${claim.text} ${claim.warrant}`),
    ...run.turns.map((turn) => turn.content),
    run.summary.headline,
    run.summary.recommendation,
    ...run.summary.strongestPro,
    ...run.summary.strongestCon
  ].join(" ");
  const words = allText.split(/\s+/).filter(Boolean);
  const uniqueWords = new Set(words.map((word) => word.toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean));
  const dimensions = {
    completeness: scoreCompleteness(run),
    balance: scoreBalance(run),
    evidenceUse: scoreEvidenceUse(run),
    readability: scoreReadability(words),
    decisiveness: scoreDecisiveness(run),
    debateCraft: scoreDebateCraft(run),
    specificity: clamp((uniqueWords.size / Math.max(words.length, 1)) * 150, 0, 100)
  };
  const quality =
    dimensions.completeness * 0.18 +
    dimensions.balance * 0.14 +
    dimensions.evidenceUse * 0.14 +
    dimensions.readability * 0.14 +
    dimensions.decisiveness * 0.12 +
    dimensions.debateCraft * 0.18 +
    dimensions.specificity * 0.1;
  const heuristicQuality = clamp(quality, 0, 100);

  if (!qualityJudge || !llmJudgeModel) {
    return {
      quality: heuristicQuality,
      heuristicQuality,
      llmQuality: null,
      dimensions,
      llmJudgeModel: null,
      llmJudgeCostUsd: null,
      llmJudgeLatencyMs: null,
      llmJudgeRetryCount: 0,
      llmJudgeRationale: null,
      llmJudgeStrengths: [],
      llmJudgeWeaknesses: [],
      secondJudgeModel: null,
      secondJudgeQuality: null,
      secondJudgeCostUsd: null,
      secondJudgeLatencyMs: null,
      secondJudgeRetryCount: 0,
      secondJudgeRationale: null,
      secondJudgeReason: null
    };
  }

  const judged = await judgeRunQuality({
    run,
    question,
    provider: qualityJudge
  });
  const primaryLlmQuality = clamp(judged.data.overallQuality, 0, 100);
  const secondOpinionReason = secondJudgeReason({
    mode: secondJudgeMode,
    heuristicQuality,
    primaryLlmQuality,
    run
  });
  const secondJudged = secondQualityJudge && secondJudgeModel && secondOpinionReason
    ? await judgeRunQuality({
        run,
        question,
        provider: secondQualityJudge
      })
    : null;
  const secondJudgeQuality = secondJudged ? clamp(secondJudged.data.overallQuality, 0, 100) : null;
  const llmQuality =
    secondJudgeQuality === null
      ? primaryLlmQuality
      : clamp((primaryLlmQuality + secondJudgeQuality) / 2, 0, 100);
  const blendedQuality = clamp(llmQuality * llmJudgeWeight + heuristicQuality * (1 - llmJudgeWeight), 0, 100);
  const mergedDimensions = {
    ...dimensions,
    llmArgumentQuality: clamp(judged.data.dimensions.argumentQuality, 0, 100),
    llmEvidenceUse: clamp(judged.data.dimensions.evidenceUse, 0, 100),
    llmFairness: clamp(judged.data.dimensions.fairness, 0, 100),
    llmAgeAppropriateClarity: clamp(judged.data.dimensions.ageAppropriateClarity, 0, 100),
    llmDecisiveness: clamp(judged.data.dimensions.decisiveness, 0, 100),
    llmGroundedness: clamp(judged.data.dimensions.groundedness, 0, 100)
  };

  return {
    quality: blendedQuality,
    heuristicQuality,
    llmQuality,
    dimensions: mergedDimensions,
    llmJudgeModel,
    llmJudgeCostUsd: judged.snapshot.estimatedCostUsd ?? 0,
    llmJudgeLatencyMs: judged.snapshot.latencyMs,
    llmJudgeRetryCount: retryCount([judged.snapshot]),
    llmJudgeRationale: judged.data.rationale,
    llmJudgeStrengths: judged.data.strengths,
    llmJudgeWeaknesses: judged.data.weaknesses,
    secondJudgeModel: secondJudged ? secondJudgeModel : null,
    secondJudgeQuality,
    secondJudgeCostUsd: secondJudged?.snapshot.estimatedCostUsd ?? null,
    secondJudgeLatencyMs: secondJudged?.snapshot.latencyMs ?? null,
    secondJudgeRetryCount: secondJudged ? retryCount([secondJudged.snapshot]) : 0,
    secondJudgeRationale: secondJudged?.data.rationale ?? null,
    secondJudgeReason: secondJudged ? secondOpinionReason : null
  };
}

async function judgeRunQuality({
  run,
  question,
  provider
}: {
  run: DebateRun;
  question: EvalQuestion;
  provider: OpenRouterLlmProvider;
}) {
  return provider.generateStructured<QualityJudgeOutput>({
    role: "evaluation judge",
    schemaName: "debatefrogModelQualityScore",
    jsonSchema: qualityJudgeOutputSchema,
    prompt: JSON.stringify({
      task: "Score this Debatefrog debate output for real user-facing quality. Be skeptical of generic, shallow, circular, one-sided, or unsafe reasoning. Reward clear kid-friendly explanations, balanced debate, grounded use of evidence, and a decisive but well-qualified judge verdict.",
      scoringInstructions: {
        overallQuality: "0 to 100. Use 50 for barely acceptable, 70 for solid, 85 for strong, 95 for excellent. Do not inflate scores just because the output is complete.",
        argumentQuality: "Do the YES and NO cases make meaningful, question-specific arguments rather than generic filler?",
        evidenceUse: "Are claims supported by the provided evidence without exaggerating sources?",
        fairness: "Are both sides represented seriously, with no default YES or NO bias?",
        ageAppropriateClarity: "Would a middle-school user understand it without being talked down to?",
        decisiveness: "Does the judge choose YES or NO when one side is stronger and explain why?",
        groundedness: "Does the verdict follow from the debate content rather than vibes or unsupported assertions? Penalize narrator voice, repeated restatements, unsupported 'studies show' language, and rebuttals that dodge cross-examination questions."
      },
      question: question.question,
      questionPurpose: question.why,
      sources: run.sources.map((source) => ({
        id: source.id,
        title: source.title,
        snippet: source.snippet,
        status: source.status
      })),
      claims: run.claims.map((claim) => ({
        side: claim.side,
        text: claim.text,
        warrant: claim.warrant,
        confidence: claim.confidence,
        evidenceSourceIds: claim.evidenceSourceIds
      })),
      turns: run.turns.map((turn) => ({
        round: turn.round,
        side: turn.side,
        content: turn.content,
        sourceIds: turn.sourceIds
      })),
      scorecard: run.scorecard,
      summary: run.summary
    })
  });
}

function secondJudgeReason({
  mode,
  heuristicQuality,
  primaryLlmQuality,
  run
}: {
  mode: "off" | "auto" | "always";
  heuristicQuality: number;
  primaryLlmQuality: number;
  run: DebateRun;
}) {
  if (mode === "off") return null;
  if (mode === "always") return "always";
  const disagreement = Math.abs(primaryLlmQuality - heuristicQuality);
  if (disagreement >= positiveNumber(process.env.POLYVISE_EVAL_SECOND_JUDGE_DISAGREEMENT_THRESHOLD, 12)) {
    return `primary judge and rule score differed by ${Math.round(disagreement)} points`;
  }
  if (primaryLlmQuality >= 68 && primaryLlmQuality <= 88) {
    return "primary score was in the model-ranking decision band";
  }
  if (retryCount(run.modelSnapshots) > 0) {
    return "debate generation needed a retry";
  }
  return null;
}

function scoreCompleteness(run: DebateRun) {
  const hasAllRounds = new Set(run.turns.map((turn) => turn.round)).size >= 4;
  const enoughClaims = run.claims.length >= 2;
  const hasSummary = Boolean(run.summary.headline && run.summary.recommendation);
  return (hasAllRounds ? 40 : 0) + (enoughClaims ? 30 : 0) + (hasSummary ? 30 : 0);
}

function scoreBalance(run: DebateRun) {
  const proTurns = run.turns.filter((turn) => turn.side === "pro").length;
  const conTurns = run.turns.filter((turn) => turn.side === "con").length;
  const total = proTurns + conTurns;
  if (!total) return 0;
  return clamp(100 - Math.abs(proTurns - conTurns) * 20, 0, 100);
}

function scoreEvidenceUse(run: DebateRun) {
  const acceptedSources = run.sources.filter((source) => source.status === "accepted").length;
  const sourcedTurns = run.turns.filter((turn) => turn.sourceIds.length > 0).length;
  return clamp(acceptedSources * 18 + sourcedTurns * 8, 0, 100);
}

function scoreReadability(words: string[]) {
  if (!words.length) return 0;
  const averageWordLength = words.join("").length / words.length;
  const sentenceCount = Math.max(1, words.join(" ").split(/[.!?]+/).filter(Boolean).length);
  const averageSentenceLength = words.length / sentenceCount;
  const wordScore = clamp(100 - Math.abs(averageWordLength - 5.2) * 20, 0, 100);
  const sentenceScore = clamp(100 - Math.max(0, averageSentenceLength - 22) * 4, 0, 100);
  return wordScore * 0.45 + sentenceScore * 0.55;
}

function scoreDecisiveness(run: DebateRun) {
  if (run.scorecard.recommendation === "mixed") return 55;
  return clamp(run.scorecard.confidence * 100, 0, 100);
}

function scoreDebateCraft(run: DebateRun) {
  const narratorPenalty = run.turns.filter((turn) =>
    /\b(?:The\s+)?(?:YES|NO)\s+side\b|\b(?:the\s+)?(?:pro|con)\s+side\b/i.test(turn.content)
  ).length * 12;
  const unsupportedResearchPenalty = unsupportedResearchClaims(run) * 10;
  const weakRebuttalPenalty = weakRebuttals(run) * 12;
  const repetitionPenalty = repeatedLaterTurns(run) * 10;

  return clamp(100 - narratorPenalty - unsupportedResearchPenalty - weakRebuttalPenalty - repetitionPenalty, 0, 100);
}

function unsupportedResearchClaims(run: DebateRun) {
  const sourceById = new Map(run.sources.map((source) => [source.id, source]));
  const researchPattern = /\b(studies show|research (?:shows|says|suggests)|evidence shows|data shows)\b/i;
  let count = 0;

  for (const turn of run.turns) {
    if (researchPattern.test(turn.content) && !hasMeaningfulSource(turn.sourceIds, sourceById)) {
      count += 1;
    }
  }

  for (const claim of run.claims) {
    const claimText = `${claim.text} ${claim.warrant}`;
    if (researchPattern.test(claimText) && !hasMeaningfulSource(claim.evidenceSourceIds, sourceById)) {
      count += 1;
    }
  }

  return count;
}

function hasMeaningfulSource(sourceIds: string[], sourceById: Map<string, DebateRun["sources"][number]>) {
  return sourceIds.some((id) => {
    const source = sourceById.get(id);
    if (!source || source.status !== "accepted") return false;
    if (source.url.includes("example.com/evidence-provider-required")) return false;
    if (source.title.toLowerCase().includes("evidence search placeholder")) return false;
    if (source.retrievedVia === "mock" && source.quality === "methodology") return false;
    return true;
  });
}

function weakRebuttals(run: DebateRun) {
  const opponentQuestionTerms = new Map<"pro" | "con", Set<string>>();
  for (const side of ["pro", "con"] as const) {
    const opponentQuestion = run.turns.find(
      (turn) => turn.round === "cross_examination" && turn.side !== side
    );
    opponentQuestionTerms.set(side, meaningfulTerms(opponentQuestion?.content ?? ""));
  }

  let weak = 0;
  for (const turn of run.turns.filter((item) => item.round === "rebuttal" && (item.side === "pro" || item.side === "con"))) {
    const responseTerms = meaningfulTerms(turn.content);
    const questionTerms = opponentQuestionTerms.get(turn.side) ?? new Set<string>();
    const overlap = [...questionTerms].filter((term) => responseTerms.has(term)).length;
    const signalsAnswer = /\b(my opponent|the other frog|you asked|your question|your concern|your worry|you said|right that)\b/i.test(
      turn.content
    );
    if (!signalsAnswer || (questionTerms.size >= 4 && overlap < 2)) {
      weak += 1;
    }
  }

  return weak;
}

function repeatedLaterTurns(run: DebateRun) {
  let repeated = 0;
  for (const side of ["pro", "con"] as const) {
    const opening = run.turns.find((turn) => turn.round === "opening" && turn.side === side);
    if (!opening) continue;
    const openingTerms = meaningfulTerms(opening.content);
    for (const turn of run.turns.filter((item) => item.side === side && (item.round === "rebuttal" || item.round === "closing"))) {
      const terms = meaningfulTerms(turn.content);
      const overlap = [...terms].filter((term) => openingTerms.has(term)).length;
      const similarity = overlap / Math.max(terms.size, 1);
      const clashSignal = /\b(my opponent|the other frog|you asked|but|however|even if|weigh|matters more|because)\b/i.test(
        turn.content
      );
      if (similarity > 0.72 && !clashSignal) {
        repeated += 1;
      }
    }
  }

  return repeated;
}

function meaningfulTerms(value: string): Set<string> {
  const stopWords = new Set([
    "about",
    "after",
    "again",
    "also",
    "because",
    "being",
    "could",
    "does",
    "each",
    "from",
    "have",
    "into",
    "more",
    "most",
    "other",
    "should",
    "side",
    "that",
    "their",
    "there",
    "these",
    "they",
    "this",
    "vote",
    "what",
    "when",
    "where",
    "which",
    "while",
    "with",
    "would",
    "your"
  ]);

  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length > 3 && !stopWords.has(term))
  );
}

function summarizeModel(id: string, label: string, runs: ModelEvalRun[]): ModelEvalSummary {
  const successful = runs.filter((run) => run.status === "ok");
  const dimensions = averageDimensions(successful.map((run) => run.dimensions).filter(Boolean) as Array<Record<string, number>>);
  const commonFailure = mostCommonFailure(runs);
  return {
    id,
    label,
    provider: providerForModel(id),
    evaluated: true,
    questionCount: runs.length,
    averageQuality: average(successful.map((run) => run.quality)),
    averageHeuristicQuality: average(successful.map((run) => run.heuristicQuality)),
    averageLlmQuality: average(successful.map((run) => run.llmQuality)),
    averageSecondJudgeQuality: average(successful.map((run) => run.secondJudgeQuality)),
    averageLatencyMs: average(successful.map((run) => run.latencyMs)),
    latencyP50Ms: percentile(successful.map((run) => run.latencyMs), 0.5),
    latencyP90Ms: percentile(successful.map((run) => run.latencyMs), 0.9),
    averageCostUsd: average(successful.map((run) => run.costUsd)),
    successRate: runs.length ? successful.length / runs.length : null,
    retryRate: successful.length ? successful.filter((run) => run.retryCount > 0).length / successful.length : null,
    failureCount: runs.length - successful.length,
    dimensions,
    notes: successful.length === runs.length
      ? "Evaluation completed."
      : commonFailure
        ? `Some evaluation questions failed: ${commonFailure}`
        : "Some evaluation questions failed.",
    runs
  };
}

function unevaluatedModel(id: string, label: string, questionCount: number, reason: string): ModelEvalSummary {
  return {
    id,
    label,
    provider: providerForModel(id),
    evaluated: false,
    questionCount,
    averageQuality: null,
    averageHeuristicQuality: null,
    averageLlmQuality: null,
    averageSecondJudgeQuality: null,
    averageLatencyMs: null,
    latencyP50Ms: null,
    latencyP90Ms: null,
    averageCostUsd: null,
    successRate: null,
    retryRate: null,
    failureCount: null,
    dimensions: null,
    notes: `Not evaluated because the run stopped early: ${reason}`,
    runs: []
  };
}

function mostCommonFailure(runs: ModelEvalRun[]) {
  const counts = new Map<string, number>();
  for (const run of runs) {
    if (!run.failureReason) continue;
    counts.set(run.failureReason, (counts.get(run.failureReason) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
}

function totalLatency(snapshots: ModelSnapshot[]): number {
  return sum(snapshots.map((snapshot) => snapshot.latencyMs));
}

function totalCost(snapshots: ModelSnapshot[]): number {
  return sum(snapshots.map((snapshot) => snapshot.estimatedCostUsd));
}

function retryCount(snapshots: ModelSnapshot[]) {
  return snapshots.reduce((total, snapshot) => {
    const attempts = snapshot.attempts ?? [];
    return total + Math.max(0, attempts.length - 1);
  }, 0);
}

function bestBy(models: ModelEvalSummary[], key: "averageQuality" | "averageLatencyMs" | "averageCostUsd", direction: "asc" | "desc") {
  const candidates = models.filter((model) => model[key] !== null);
  candidates.sort((left, right) => {
    const diff = (left[key] ?? 0) - (right[key] ?? 0);
    return direction === "asc" ? diff : -diff;
  });
  return candidates[0]?.id ?? null;
}

function average(values: Array<number | null | undefined>) {
  const valid = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!valid.length) return null;
  return valid.reduce((total, value) => total + value, 0) / valid.length;
}

function percentile(values: Array<number | null | undefined>, p: number) {
  const valid = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
  if (!valid.length) return null;
  const index = Math.min(valid.length - 1, Math.max(0, Math.ceil(valid.length * p) - 1));
  return valid[index];
}

function averageDimensions(dimensions: Array<Record<string, number>>) {
  if (!dimensions.length) return null;
  const keys = Object.keys(dimensions[0] ?? {});
  return Object.fromEntries(keys.map((key) => [key, average(dimensions.map((item) => item[key])) ?? 0]));
}

function sum(values: Array<number | null | undefined>): number {
  return values.reduce<number>(
    (total, value) => total + (typeof value === "number" && Number.isFinite(value) ? value : 0),
    0
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function providerForModel(id: string) {
  const provider = id.split("/")[0] ?? "unknown";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function labelForModel(id: string) {
  return id.split("/").pop()!.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()).replace(/\bGpt\b/g, "GPT");
}

function slug(value: string) {
  return value.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}

function toCsv(report: ModelEvalReport) {
  const rows = [
    [
      "model_id",
      "label",
      "provider",
      "evaluated",
      "question_count",
      "average_quality",
      "average_llm_quality",
      "average_second_judge_quality",
      "average_heuristic_quality",
      "average_latency_ms",
      "latency_p50_ms",
      "latency_p90_ms",
      "average_cost_usd",
      "success_rate",
      "retry_rate",
      "llm_judge_model",
      "second_judge_model",
      "average_llm_judge_cost_usd",
      "average_second_judge_cost_usd",
      "average_llm_judge_latency_ms",
      "average_second_judge_latency_ms",
      "failure_count",
      "notes"
    ],
    ...report.models.map((model) => [
      model.id,
      model.label,
      model.provider,
      String(model.evaluated),
      String(model.questionCount),
      formatCsvNumber(model.averageQuality),
      formatCsvNumber(model.averageLlmQuality),
      formatCsvNumber(model.averageSecondJudgeQuality),
      formatCsvNumber(model.averageHeuristicQuality),
      formatCsvNumber(model.averageLatencyMs),
      formatCsvNumber(model.latencyP50Ms),
      formatCsvNumber(model.latencyP90Ms),
      formatCsvNumber(model.averageCostUsd),
      formatCsvNumber(model.successRate),
      formatCsvNumber(model.retryRate),
      mostCommonLlmJudgeModel(model.runs) ?? "",
      mostCommonSecondJudgeModel(model.runs) ?? "",
      formatCsvNumber(average(model.runs.map((run) => run.llmJudgeCostUsd))),
      formatCsvNumber(average(model.runs.map((run) => run.secondJudgeCostUsd))),
      formatCsvNumber(average(model.runs.map((run) => run.llmJudgeLatencyMs))),
      formatCsvNumber(average(model.runs.map((run) => run.secondJudgeLatencyMs))),
      String(model.failureCount ?? ""),
      model.notes
    ])
  ];
  return rows.map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

function mostCommonLlmJudgeModel(runs: ModelEvalRun[]) {
  const counts = new Map<string, number>();
  for (const run of runs) {
    if (!run.llmJudgeModel) continue;
    counts.set(run.llmJudgeModel, (counts.get(run.llmJudgeModel) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
}

function mostCommonSecondJudgeModel(runs: ModelEvalRun[]) {
  const counts = new Map<string, number>();
  for (const run of runs) {
    if (!run.secondJudgeModel) continue;
    counts.set(run.secondJudgeModel, (counts.get(run.secondJudgeModel) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
}

function formatCsvNumber(value: number | null) {
  return value === null ? "" : String(Number(value.toFixed(6)));
}

function csvCell(value: string) {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, "\"\"")}"` : value;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
