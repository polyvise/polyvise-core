"use client";

import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Loader2,
  MessageSquarePlus,
  RotateCcw,
  Settings2,
  SendHorizontal
} from "lucide-react";
import { FormEvent, useMemo, useRef, useState } from "react";
import { ArgumentMap } from "@/components/argument-map";
import {
  defaultSelections,
  modelCatalog,
  slots,
  type SlotId
} from "@/lib/model-catalog";
import type {
  Claim,
  DebateRecord,
  DebateRound,
  EvidenceSource,
  ModelSnapshot,
  RoundTurn,
  Scorecard
} from "@polyvise/debate-engine/debate/types";

const examples = [
  "Should a small company adopt AI customer support this year?",
  "Should cities ban private cars from dense downtown cores?",
  "Is nuclear power a good climate strategy?",
  "Should I take a fully remote job over a higher-paying hybrid offer?",
  "Should schools allow phones during the day?"
];

type ModelSelections = Record<SlotId, string>;

type PendingDebate = {
  subject: string;
  context: string;
  models: ModelSelections;
};

export function DebateWorkspace() {
  const [subject, setSubject] = useState("");
  const [context, setContext] = useState("");
  const [models, setModels] = useState<ModelSelections>(defaultSelections);
  const [showModels, setShowModels] = useState(false);
  const [debate, setDebate] = useState<DebateRecord | null>(null);
  const [pending, setPending] = useState<PendingDebate | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [followupQuestion, setFollowupQuestion] = useState("");
  const [isFollowupLoading, setIsFollowupLoading] = useState(false);
  const resultRef = useRef<HTMLDivElement | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (subject.trim().length < 4 || isSubmitting) {
      return;
    }
    setIsSubmitting(true);
    setError(null);
    setDebate(null);
    setPending({ subject, context, models });

    try {
      const response = await fetch("/api/debates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject,
          context: context || undefined,
          mode: "hybrid_council",
          evidence: "cited",
          models
        })
      });

      const payload = (await response.json()) as { debate?: DebateRecord; error?: string };

      if (!response.ok || !payload.debate) {
        throw new Error(payload.error ?? "Unable to run the debate.");
      }

      setDebate(payload.debate);
      requestAnimationFrame(() => {
        resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to run the debate.");
    } finally {
      setIsSubmitting(false);
      setPending(null);
    }
  }

  async function handleFollowup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!debate || followupQuestion.trim().length < 4) {
      return;
    }
    setIsFollowupLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/debates/${debate.id}/followups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: followupQuestion })
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? "Unable to answer the follow-up.");
      }
      const refreshed = await fetch(`/api/debates/${debate.id}`, { cache: "no-store" });
      const refreshedPayload = (await refreshed.json()) as { debate: DebateRecord };
      setDebate(refreshedPayload.debate);
      setFollowupQuestion("");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to answer the follow-up.");
    } finally {
      setIsFollowupLoading(false);
    }
  }

  function startNewDebate() {
    setDebate(null);
    setError(null);
    setFollowupQuestion("");
  }

  return (
    <main className="min-h-screen">
      <div className="border-b border-graphite/10 bg-paper/80 backdrop-blur">
        <div className="mx-auto flex max-w-[1180px] items-center justify-between px-5 py-3">
          <span className="text-sm font-semibold tracking-tight text-ink">polyvise</span>
          {debate ? (
            <button
              type="button"
              onClick={startNewDebate}
              className="inline-flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium text-graphite/70 transition hover:text-ink"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              New debate
            </button>
          ) : null}
        </div>
      </div>

      <div className="mx-auto w-full max-w-[1180px] px-5 py-8 sm:py-12">
        {!debate ? (
          <InputState
            subject={subject}
            onSubjectChange={setSubject}
            context={context}
            onContextChange={setContext}
            models={models}
            onModelsChange={setModels}
            showModels={showModels}
            onToggleModels={() => setShowModels((v) => !v)}
            isSubmitting={isSubmitting}
            pending={pending}
            error={error}
            onSubmit={handleSubmit}
          />
        ) : (
          <div ref={resultRef}>
            <ResultsState
              debate={debate}
              models={models}
              followupQuestion={followupQuestion}
              onFollowupQuestionChange={setFollowupQuestion}
              onFollowupSubmit={handleFollowup}
              isFollowupLoading={isFollowupLoading}
              error={error}
              onRerun={() => {
                setDebate(null);
                setShowModels(true);
              }}
            />
          </div>
        )}
      </div>
    </main>
  );
}

function InputState({
  subject,
  onSubjectChange,
  context,
  onContextChange,
  models,
  onModelsChange,
  showModels,
  onToggleModels,
  isSubmitting,
  pending,
  error,
  onSubmit
}: {
  subject: string;
  onSubjectChange: (value: string) => void;
  context: string;
  onContextChange: (value: string) => void;
  models: ModelSelections;
  onModelsChange: (models: ModelSelections) => void;
  showModels: boolean;
  onToggleModels: () => void;
  isSubmitting: boolean;
  pending: PendingDebate | null;
  error: string | null;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  if (isSubmitting && pending) {
    return <RunningState pending={pending} />;
  }

  return (
    <div className="mx-auto max-w-[720px]">
      <h1 className="text-3xl font-semibold leading-tight text-ink sm:text-4xl">
        Ask a question. Agents debate it.
      </h1>
      <p className="mt-2 text-base leading-relaxed text-graphite/75">
        Pro and con agents argue the question, a judge weighs the evidence, and you see the result.
      </p>

      <form onSubmit={onSubmit} className="mt-8 space-y-4">
        <div>
          <label htmlFor="subject" className="mb-1.5 block text-sm font-medium text-graphite">
            Question
          </label>
          <textarea
            id="subject"
            value={subject}
            onChange={(event) => onSubjectChange(event.target.value)}
            placeholder="Should my team adopt an AI support agent this quarter?"
            className="min-h-[110px] w-full resize-y rounded-md border border-graphite/20 bg-white px-3.5 py-3 text-base leading-relaxed text-ink outline-none transition focus:border-jade"
          />
        </div>

        <div>
          <label htmlFor="context" className="mb-1.5 block text-sm font-medium text-graphite">
            Context <span className="text-graphite/50">(optional)</span>
          </label>
          <textarea
            id="context"
            value={context}
            onChange={(event) => onContextChange(event.target.value)}
            placeholder="Constraints, audience, time horizon, or what you already believe."
            className="min-h-[80px] w-full resize-y rounded-md border border-graphite/20 bg-white px-3.5 py-2.5 text-sm leading-relaxed text-ink outline-none transition focus:border-jade"
          />
        </div>

        <ModelPicker models={models} onModelsChange={onModelsChange} open={showModels} onToggle={onToggleModels} />

        {error ? (
          <div className="flex gap-2 rounded-md border border-coral/30 bg-coral/5 px-3 py-2.5 text-sm text-graphite">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-coral" />
            <span>{error}</span>
          </div>
        ) : null}

        <button
          type="submit"
          disabled={subject.trim().length < 4}
          className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-ink px-4 py-3 text-sm font-semibold text-white transition hover:bg-graphite disabled:cursor-not-allowed disabled:bg-graphite/30"
        >
          <SendHorizontal className="h-4 w-4" />
          Run debate
        </button>
      </form>

      <div className="mt-8">
        <div className="mb-3 text-xs font-medium text-graphite/60">Try a sample question</div>
        <div className="flex flex-wrap gap-2">
          {examples.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => onSubjectChange(example)}
              className="rounded-full border border-graphite/15 bg-white px-3 py-1.5 text-xs text-graphite transition hover:border-jade/40 hover:text-ink"
            >
              {example}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ModelPicker({
  models,
  onModelsChange,
  open,
  onToggle
}: {
  models: ModelSelections;
  onModelsChange: (models: ModelSelections) => void;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded-md border border-graphite/15 bg-white">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-3.5 py-2.5 text-left"
      >
        <span className="flex items-center gap-2 text-sm font-medium text-graphite">
          <Settings2 className="h-4 w-4 text-graphite/60" />
          Models
          <span className="text-xs font-normal text-graphite/55">
            {modelLabel(models.quick)} · {modelLabel(models.deep)} · {modelLabel(models.judge)}
          </span>
        </span>
        {open ? (
          <ChevronUp className="h-4 w-4 text-graphite/60" />
        ) : (
          <ChevronDown className="h-4 w-4 text-graphite/60" />
        )}
      </button>
      {open ? (
        <div className="border-t border-graphite/10 p-3.5">
          <div className="grid gap-3 sm:grid-cols-3">
            {slots.map((slot) => (
              <div key={slot.id}>
                <label
                  htmlFor={`model-${slot.id}`}
                  className="mb-1 block text-xs font-medium text-graphite"
                >
                  {slot.title}
                </label>
                <select
                  id={`model-${slot.id}`}
                  value={models[slot.id]}
                  onChange={(event) =>
                    onModelsChange({ ...models, [slot.id]: event.target.value })
                  }
                  className="w-full rounded-md border border-graphite/20 bg-white px-2.5 py-2 text-sm text-ink outline-none transition focus:border-jade"
                >
                  {modelCatalog.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                      {option.notes ? ` — ${option.notes}` : ""}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] leading-snug text-graphite/55">{slot.description}</p>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function modelLabel(id: string): string {
  const entry = modelCatalog.find((option) => option.id === id);
  return entry?.label ?? id;
}

function RunningState({ pending }: { pending: PendingDebate }) {
  const stages = [
    { id: "framing", label: "Framing the resolution" },
    { id: "researching", label: "Gathering evidence" },
    { id: "debating", label: "Agents debating" },
    { id: "judging", label: "Judge synthesizing" }
  ];

  return (
    <div className="mx-auto max-w-[720px]">
      <div className="rounded-md border border-graphite/15 bg-white px-5 py-5">
        <div className="text-xs font-medium uppercase tracking-wide text-graphite/55">Running</div>
        <h2 className="mt-1 text-lg font-semibold leading-snug text-ink">{pending.subject}</h2>
        <div className="mt-1 text-xs text-graphite/60">
          Pro {modelLabel(pending.models.quick)} · Con {modelLabel(pending.models.deep)} · Judge{" "}
          {modelLabel(pending.models.judge)}
        </div>
        <div className="mt-5 space-y-2">
          {stages.map((stage) => (
            <div
              key={stage.id}
              className="flex items-center gap-3 rounded-md border border-graphite/10 bg-paper px-3 py-2.5"
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin text-jade" />
              <span className="text-sm text-graphite">{stage.label}</span>
            </div>
          ))}
        </div>
        <p className="mt-5 text-xs leading-relaxed text-graphite/55">
          A full debate run usually completes in under a minute. The page will update with the
          verdict and transcript when finished.
        </p>
      </div>
    </div>
  );
}

function ResultsState({
  debate,
  models,
  followupQuestion,
  onFollowupQuestionChange,
  onFollowupSubmit,
  isFollowupLoading,
  error,
  onRerun
}: {
  debate: DebateRecord;
  models: ModelSelections;
  followupQuestion: string;
  onFollowupQuestionChange: (value: string) => void;
  onFollowupSubmit: (event: FormEvent<HTMLFormElement>) => void;
  isFollowupLoading: boolean;
  error: string | null;
  onRerun: () => void;
}) {
  const run = debate.latestRun;
  const summary = run?.summary;
  const scorecard = run?.scorecard;

  if (!run || !summary || !scorecard) {
    return (
      <div className="rounded-md border border-graphite/15 bg-white p-6 text-sm text-graphite">
        The debate did not produce a complete run.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Verdict
        debate={debate}
        summary={summary}
        scorecard={scorecard}
        models={models}
        onRerun={onRerun}
      />

      <ProsConsRow claims={run.claims} />

      <ContextRow summary={summary} />

      <Disclosure title="Argument map" defaultOpen>
        <ArgumentMap nodes={run.argumentNodes} edges={run.argumentEdges} />
      </Disclosure>

      <Disclosure title={`Full debate transcript (${run.turns.length} turns)`}>
        <Transcript turns={run.turns} />
      </Disclosure>

      <Disclosure title={`Sources (${run.sources.length})`}>
        <SourceLedger sources={run.sources} />
      </Disclosure>

      <Disclosure title="Run details">
        <RunDetails snapshots={run.modelSnapshots} />
      </Disclosure>

      <Followups
        debate={debate}
        followupQuestion={followupQuestion}
        onFollowupQuestionChange={onFollowupQuestionChange}
        onFollowupSubmit={onFollowupSubmit}
        isFollowupLoading={isFollowupLoading}
        error={error}
      />
    </div>
  );
}

function Verdict({
  debate,
  summary,
  scorecard,
  models,
  onRerun
}: {
  debate: DebateRecord;
  summary: NonNullable<DebateRecord["latestRun"]>["summary"];
  scorecard: Scorecard;
  models: ModelSelections;
  onRerun: () => void;
}) {
  return (
    <section className="rounded-md border border-graphite/15 bg-white p-6">
      <div className="flex flex-col gap-1 text-xs text-graphite/60">
        <span>{debate.resolution}</span>
      </div>

      <div className="mt-4 flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-2xl">
          <div
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${recommendationToneClass(scorecard.recommendation)}`}
          >
            {formatRecommendation(scorecard.recommendation)}
          </div>
          <h2 className="mt-3 text-2xl font-semibold leading-snug text-ink">{summary.headline}</h2>
          <p className="mt-3 text-base leading-relaxed text-graphite">{summary.recommendation}</p>
        </div>
        <ConfidenceMeter value={scorecard.confidence} />
      </div>

      {summary.highStakesDisclaimer ? (
        <div className="mt-5 flex gap-2 rounded-md border border-saffron/35 bg-saffron/10 px-3 py-2.5 text-sm text-graphite">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-saffron" />
          <span>{summary.highStakesDisclaimer}</span>
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-graphite/10 pt-4 text-xs text-graphite/60">
        <span>
          Pro {modelLabel(models.quick)} · Con {modelLabel(models.deep)} · Judge {modelLabel(models.judge)}
        </span>
        <button
          type="button"
          onClick={onRerun}
          className="inline-flex items-center gap-1.5 rounded-md border border-graphite/20 bg-white px-2.5 py-1.5 text-xs font-medium text-graphite transition hover:border-jade/40 hover:text-ink"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Re-run with different models
        </button>
      </div>
    </section>
  );
}

function ConfidenceMeter({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  return (
    <div className="flex flex-col items-end">
      <div className="text-xs font-medium text-graphite/60">Confidence</div>
      <div className="mt-1 text-3xl font-semibold tabular-nums text-ink">{pct}%</div>
      <div className="mt-1 h-1.5 w-32 overflow-hidden rounded-full bg-linen">
        <div className="h-full bg-jade" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ProsConsRow({ claims }: { claims: Claim[] }) {
  const pros = claims.filter((claim) => claim.side === "pro");
  const cons = claims.filter((claim) => claim.side === "con");

  return (
    <section className="grid gap-4 md:grid-cols-2">
      <ClaimCard title="Strongest pros" tone="pro" claims={pros} />
      <ClaimCard title="Strongest cons" tone="con" claims={cons} />
    </section>
  );
}

function ClaimCard({
  title,
  tone,
  claims
}: {
  title: string;
  tone: "pro" | "con";
  claims: Claim[];
}) {
  const accent = tone === "pro" ? "text-jade" : "text-coral";
  return (
    <article className="rounded-md border border-graphite/15 bg-white p-5">
      <h3 className={`text-sm font-semibold ${accent}`}>{title}</h3>
      <ul className="mt-3 space-y-3">
        {claims.map((claim) => (
          <li key={claim.id} className="border-l-2 border-graphite/10 pl-3">
            <p className="text-sm font-medium leading-relaxed text-ink">{claim.text}</p>
            <p className="mt-1 text-xs leading-relaxed text-graphite/70">{claim.warrant}</p>
          </li>
        ))}
      </ul>
    </article>
  );
}

function ContextRow({
  summary
}: {
  summary: NonNullable<DebateRecord["latestRun"]>["summary"];
}) {
  return (
    <section className="grid gap-4 md:grid-cols-2">
      <article className="rounded-md border border-graphite/15 bg-white p-5">
        <h3 className="text-sm font-semibold text-graphite">Unresolved questions</h3>
        <ul className="mt-3 space-y-2 text-sm leading-relaxed text-graphite">
          {summary.unresolvedUncertainties.map((item) => (
            <li key={item} className="border-l-2 border-graphite/10 pl-3">
              {item}
            </li>
          ))}
        </ul>
      </article>
      <article className="rounded-md border border-graphite/15 bg-white p-5">
        <h3 className="text-sm font-semibold text-graphite">What would change the answer</h3>
        <ul className="mt-3 space-y-2 text-sm leading-relaxed text-graphite">
          {summary.whatWouldChangeMind.map((item) => (
            <li key={item} className="border-l-2 border-graphite/10 pl-3">
              {item}
            </li>
          ))}
        </ul>
      </article>
    </section>
  );
}

function Disclosure({
  title,
  defaultOpen = false,
  children
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-md border border-graphite/15 bg-white">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-5 py-3 text-left"
      >
        <span className="text-sm font-semibold text-ink">{title}</span>
        {open ? (
          <ChevronUp className="h-4 w-4 text-graphite/60" />
        ) : (
          <ChevronDown className="h-4 w-4 text-graphite/60" />
        )}
      </button>
      {open ? <div className="border-t border-graphite/10 p-5">{children}</div> : null}
    </section>
  );
}

function Transcript({ turns }: { turns: RoundTurn[] }) {
  const grouped = useMemo(() => groupTurns(turns), [turns]);

  return (
    <div className="space-y-6">
      {Object.entries(grouped).map(([round, roundTurns]) => (
        <div key={round}>
          <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-graphite/55">
            {formatRound(round as DebateRound)}
          </div>
          <div className="space-y-3">
            {roundTurns.map((turn) => (
              <article
                key={turn.id}
                className={`rounded-md border-l-2 bg-paper/60 px-4 py-3 ${
                  turn.side === "pro"
                    ? "border-jade/60"
                    : turn.side === "con"
                      ? "border-coral/60"
                      : "border-plum/50"
                }`}
              >
                <div className="mb-1 flex items-center gap-2 text-xs">
                  <span className="font-semibold text-ink">{turn.agentName}</span>
                  <SideBadge side={turn.side} />
                </div>
                <p className="text-sm leading-relaxed text-graphite">{turn.content}</p>
              </article>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function SourceLedger({ sources }: { sources: EvidenceSource[] }) {
  return (
    <div className="space-y-3">
      {sources.map((source) => (
        <article key={source.id} className="rounded-md border border-graphite/10 bg-paper/60 p-3">
          <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-graphite/55">
            <span>{source.quality}</span>
            <span>·</span>
            <span>{source.retrievedVia}</span>
            <span>·</span>
            <span>{source.status}</span>
          </div>
          <a
            href={source.url}
            target="_blank"
            rel="noreferrer"
            className="text-sm font-semibold text-ink hover:text-jade"
          >
            {source.title}
          </a>
          <div className="mt-0.5 text-xs text-graphite/60">{source.publisher}</div>
          <p className="mt-2 text-sm leading-relaxed text-graphite/75">{source.snippet}</p>
        </article>
      ))}
    </div>
  );
}

function RunDetails({ snapshots }: { snapshots: ModelSnapshot[] }) {
  return (
    <div className="space-y-2">
      {snapshots.map((snapshot) => (
        <div
          key={snapshot.id}
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-graphite/10 bg-paper/60 px-3 py-2"
        >
          <div className="min-w-0">
            <div className="text-sm font-medium text-ink">{snapshot.model}</div>
            <div className="text-xs text-graphite/60">{snapshot.role}</div>
          </div>
          <div className="text-xs text-graphite/60">
            {snapshot.latencyMs ? `${snapshot.latencyMs}ms` : null}
            {snapshot.failure ? <span className="ml-2 text-coral">{snapshot.failure}</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function Followups({
  debate,
  followupQuestion,
  onFollowupQuestionChange,
  onFollowupSubmit,
  isFollowupLoading,
  error
}: {
  debate: DebateRecord;
  followupQuestion: string;
  onFollowupQuestionChange: (value: string) => void;
  onFollowupSubmit: (event: FormEvent<HTMLFormElement>) => void;
  isFollowupLoading: boolean;
  error: string | null;
}) {
  return (
    <section className="rounded-md border border-graphite/15 bg-white p-5">
      <h3 className="text-sm font-semibold text-graphite">Ask a follow-up</h3>
      <form onSubmit={onFollowupSubmit} className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          value={followupQuestion}
          onChange={(event) => onFollowupQuestionChange(event.target.value)}
          placeholder="Ask about risks, evidence, or what would change the answer."
          className="h-11 flex-1 rounded-md border border-graphite/20 bg-white px-3 text-sm text-ink outline-none transition focus:border-jade"
        />
        <button
          type="submit"
          disabled={isFollowupLoading || followupQuestion.trim().length < 4}
          className="inline-flex items-center justify-center gap-2 rounded-md bg-jade px-4 py-2 text-sm font-semibold text-white transition hover:bg-jade/90 disabled:cursor-not-allowed disabled:bg-graphite/30"
        >
          {isFollowupLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <MessageSquarePlus className="h-4 w-4" />
          )}
          Ask
        </button>
      </form>

      {error ? (
        <div className="mt-3 flex gap-2 rounded-md border border-coral/30 bg-coral/5 px-3 py-2 text-sm text-graphite">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-coral" />
          <span>{error}</span>
        </div>
      ) : null}

      {debate.followups.length > 0 ? (
        <div className="mt-4 space-y-3">
          {debate.followups.map((followup) => (
            <div key={followup.id} className="rounded-md border border-graphite/10 bg-paper/60 p-3">
              <div className="text-sm font-semibold text-ink">{followup.question}</div>
              <p className="mt-1 text-sm leading-relaxed text-graphite/75">{followup.answer}</p>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function SideBadge({ side }: { side: "pro" | "con" | "neutral" }) {
  const className =
    side === "pro"
      ? "bg-jade/10 text-jade"
      : side === "con"
        ? "bg-coral/10 text-coral"
        : "bg-plum/10 text-plum";
  return (
    <span
      className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${className}`}
    >
      {side}
    </span>
  );
}

function recommendationToneClass(rec: Scorecard["recommendation"]): string {
  switch (rec) {
    case "lean_yes":
    case "conditional_yes":
      return "border-jade/30 bg-jade/10 text-jade";
    case "lean_no":
    case "conditional_no":
      return "border-coral/30 bg-coral/10 text-coral";
    case "mixed":
    default:
      return "border-plum/30 bg-plum/10 text-plum";
  }
}

function formatRecommendation(recommendation: Scorecard["recommendation"]): string {
  switch (recommendation) {
    case "lean_yes":
      return "Lean yes";
    case "lean_no":
      return "Lean no";
    case "conditional_yes":
      return "Conditional yes";
    case "conditional_no":
      return "Conditional no";
    case "mixed":
    default:
      return "Mixed";
  }
}

function formatRound(round: DebateRound): string {
  return round.replace("_", " ");
}

function groupTurns(turns: RoundTurn[]) {
  return turns.reduce<Record<string, RoundTurn[]>>((groups, turn) => {
    groups[turn.round] = groups[turn.round] ?? [];
    groups[turn.round].push(turn);
    return groups;
  }, {});
}
