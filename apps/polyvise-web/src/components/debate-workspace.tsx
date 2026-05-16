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
import { FormEvent, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ArgumentMap } from "@/components/argument-map";
import {
  defaultSelections,
  modelCatalog,
  slots,
  type SlotId
} from "@/lib/model-catalog";
import type {
  ArgumentEdge,
  ArgumentNode,
  Claim,
  DebateLiveEvent,
  DebateRecord,
  DebateRound,
  DebateStatus,
  DebateSummary,
  DebateTeam,
  EvidenceSource,
  HighStakesNotice,
  ModelSnapshot,
  RoundTurn,
  Scorecard,
  StanceScout,
  TopicKind
} from "@polyvise/debate-engine/debate/types";

const examples = [
  "Should a small company adopt AI customer support this year?",
  "Should cities ban private cars from dense downtown cores?",
  "Is nuclear power a good climate strategy?",
  "Should I take a fully remote job over a higher-paying hybrid offer?",
  "Should schools allow phones during the day?"
];

type ModelSelections = Record<SlotId, string>;

type LiveState = {
  debateId: string;
  subject: string;
  models: ModelSelections;
  status: DebateStatus;
  resolution?: string;
  topicKind?: TopicKind;
  highStakes: HighStakesNotice | null;
  scouts: StanceScout[];
  teams: DebateTeam | null;
  sources: EvidenceSource[];
  claims: Claim[];
  argumentNodes: ArgumentNode[];
  argumentEdges: ArgumentEdge[];
  turns: RoundTurn[];
  scorecard: Scorecard | null;
  summary: DebateSummary | null;
  snapshots: ModelSnapshot[];
  errorMessage: string | null;
  done: boolean;
};

type LiveAction =
  | { type: "init"; debateId: string; subject: string; models: ModelSelections }
  | { type: "event"; event: DebateLiveEvent }
  | { type: "reset" };

function emptyLive(): LiveState | null {
  return null;
}

function liveReducer(state: LiveState | null, action: LiveAction): LiveState | null {
  if (action.type === "reset") {
    return null;
  }
  if (action.type === "init") {
    return {
      debateId: action.debateId,
      subject: action.subject,
      models: action.models,
      status: "queued",
      highStakes: null,
      scouts: [],
      teams: null,
      sources: [],
      claims: [],
      argumentNodes: [],
      argumentEdges: [],
      turns: [],
      scorecard: null,
      summary: null,
      snapshots: [],
      errorMessage: null,
      done: false
    };
  }
  if (!state) return state;
  const event = action.event;
  switch (event.kind) {
    case "stage":
      return { ...state, status: event.status };
    case "framed":
      return {
        ...state,
        resolution: event.resolution,
        topicKind: event.topicKind,
        highStakes: event.highStakes
      };
    case "scouts":
      return { ...state, scouts: event.scouts };
    case "teams":
      return { ...state, teams: event.teams };
    case "sources":
      return { ...state, sources: event.sources };
    case "claims":
      return { ...state, claims: event.claims };
    case "argument_map":
      return { ...state, argumentNodes: event.nodes, argumentEdges: event.edges };
    case "turns":
      return { ...state, turns: event.turns };
    case "scorecard":
      return { ...state, scorecard: event.scorecard };
    case "summary":
      return { ...state, summary: event.summary };
    case "model_snapshot":
      return { ...state, snapshots: [...state.snapshots, event.snapshot] };
    case "complete":
      return { ...state, status: "complete", done: true };
    case "error":
      return { ...state, status: "failed", done: true, errorMessage: event.message };
    default:
      return state;
  }
}

export function DebateWorkspace() {
  const [subject, setSubject] = useState("");
  const [context, setContext] = useState("");
  const [models, setModels] = useState<ModelSelections>(defaultSelections);
  const [showModels, setShowModels] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [debate, setDebate] = useState<DebateRecord | null>(null);
  const [live, dispatch] = useReducer(liveReducer, null, emptyLive);
  const [followupQuestion, setFollowupQuestion] = useState("");
  const [isFollowupLoading, setIsFollowupLoading] = useState(false);
  const [followupError, setFollowupError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (subject.trim().length < 4 || isSubmitting) return;

    setIsSubmitting(true);
    setSubmitError(null);
    setDebate(null);
    eventSourceRef.current?.close();

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
        throw new Error(payload.error ?? "Unable to start the debate.");
      }

      const seed = payload.debate;
      dispatch({ type: "init", debateId: seed.id, subject: seed.subject, models });

      // open SSE stream
      const es = new EventSource(`/api/debates/${seed.id}/events`);
      eventSourceRef.current = es;

      const eventKinds: DebateLiveEvent["kind"][] = [
        "stage",
        "framed",
        "scouts",
        "teams",
        "sources",
        "claims",
        "argument_map",
        "turns",
        "scorecard",
        "summary",
        "model_snapshot",
        "complete",
        "error"
      ];

      for (const kind of eventKinds) {
        es.addEventListener(kind, (msgEvent) => {
          try {
            const parsed = JSON.parse((msgEvent as MessageEvent).data) as DebateLiveEvent;
            dispatch({ type: "event", event: parsed });
          } catch {
            // ignore malformed events
          }
        });
      }

      const finalize = async () => {
        es.close();
        eventSourceRef.current = null;
        try {
          const finalRes = await fetch(`/api/debates/${seed.id}`, { cache: "no-store" });
          const finalPayload = (await finalRes.json()) as { debate?: DebateRecord };
          if (finalPayload.debate) {
            setDebate(finalPayload.debate);
          }
        } catch {
          // ignore; we still have the live state to render from
        }
      };

      es.addEventListener("complete", () => {
        void finalize();
      });
      es.addEventListener("error", () => {
        // EventSource fires its own 'error' on disconnect; treat as close only if we have terminal data
        void finalize();
      });
      es.addEventListener("closed", () => {
        es.close();
        eventSourceRef.current = null;
      });
    } catch (caughtError) {
      setSubmitError(
        caughtError instanceof Error ? caughtError.message : "Unable to start the debate."
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleFollowup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const targetId = debate?.id ?? live?.debateId;
    if (!targetId || followupQuestion.trim().length < 4) return;
    setIsFollowupLoading(true);
    setFollowupError(null);

    try {
      const response = await fetch(`/api/debates/${targetId}/followups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: followupQuestion })
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? "Unable to answer the follow-up.");
      }
      const refreshed = await fetch(`/api/debates/${targetId}`, { cache: "no-store" });
      const refreshedPayload = (await refreshed.json()) as { debate: DebateRecord };
      setDebate(refreshedPayload.debate);
      setFollowupQuestion("");
    } catch (caughtError) {
      setFollowupError(
        caughtError instanceof Error ? caughtError.message : "Unable to answer the follow-up."
      );
    } finally {
      setIsFollowupLoading(false);
    }
  }

  function startNewDebate() {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setDebate(null);
    dispatch({ type: "reset" });
    setSubmitError(null);
    setFollowupError(null);
    setFollowupQuestion("");
  }

  function rerunWithDifferentModels() {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setDebate(null);
    dispatch({ type: "reset" });
    setShowModels(true);
  }

  return (
    <main className="min-h-screen">
      <div className="border-b border-graphite/10 bg-paper/80 backdrop-blur">
        <div className="mx-auto flex max-w-[1180px] items-center justify-between px-5 py-3">
          <span className="text-sm font-semibold tracking-tight text-ink">polyvise</span>
          {live ? (
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
        {!live ? (
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
            error={submitError}
            onSubmit={handleSubmit}
          />
        ) : (
          <LiveView
            live={live}
            finalRecord={debate}
            followupQuestion={followupQuestion}
            onFollowupQuestionChange={setFollowupQuestion}
            onFollowupSubmit={handleFollowup}
            isFollowupLoading={isFollowupLoading}
            followupError={followupError}
            onRerun={rerunWithDifferentModels}
          />
        )}
      </div>
    </main>
  );
}

/* ------------------------------ Input state ------------------------------ */

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
  error: string | null;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
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
          disabled={subject.trim().length < 4 || isSubmitting}
          className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-ink px-4 py-3 text-sm font-semibold text-white transition hover:bg-graphite disabled:cursor-not-allowed disabled:bg-graphite/30"
        >
          {isSubmitting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <SendHorizontal className="h-4 w-4" />
          )}
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
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-graphite">
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
                <label htmlFor={`model-${slot.id}`} className="mb-1 block text-xs font-medium text-graphite">
                  {slot.title}
                </label>
                <select
                  id={`model-${slot.id}`}
                  value={models[slot.id]}
                  onChange={(event) => onModelsChange({ ...models, [slot.id]: event.target.value })}
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

/* ------------------------------ Live view ------------------------------ */

function LiveView({
  live,
  finalRecord,
  followupQuestion,
  onFollowupQuestionChange,
  onFollowupSubmit,
  isFollowupLoading,
  followupError,
  onRerun
}: {
  live: LiveState;
  finalRecord: DebateRecord | null;
  followupQuestion: string;
  onFollowupQuestionChange: (value: string) => void;
  onFollowupSubmit: (event: FormEvent<HTMLFormElement>) => void;
  isFollowupLoading: boolean;
  followupError: string | null;
  onRerun: () => void;
}) {
  const isComplete = live.done && live.status === "complete";
  const isFailed = live.status === "failed";

  return (
    <div className="space-y-6">
      <RunHeader live={live} />

      {isFailed ? (
        <div className="flex gap-2 rounded-md border border-coral/30 bg-coral/5 px-3 py-2.5 text-sm text-graphite">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-coral" />
          <span>{live.errorMessage ?? "The debate failed."}</span>
        </div>
      ) : null}

      <Verdict live={live} onRerun={onRerun} />

      <ProsConsRow claims={live.claims} status={live.status} />

      {live.summary ? <ContextRow summary={live.summary} /> : null}

      <DebateStage live={live} />

      {live.argumentNodes.length > 0 ? (
        <Disclosure title="Argument map">
          <ArgumentMap nodes={live.argumentNodes} edges={live.argumentEdges} />
        </Disclosure>
      ) : null}

      {live.sources.length > 0 ? (
        <Disclosure title={`Sources (${live.sources.length})`}>
          <SourceLedger sources={live.sources} />
        </Disclosure>
      ) : null}

      {live.snapshots.length > 0 ? (
        <Disclosure title="Run details">
          <RunDetails snapshots={live.snapshots} />
        </Disclosure>
      ) : null}

      {isComplete ? (
        <Followups
          followups={finalRecord?.followups ?? []}
          followupQuestion={followupQuestion}
          onFollowupQuestionChange={onFollowupQuestionChange}
          onFollowupSubmit={onFollowupSubmit}
          isFollowupLoading={isFollowupLoading}
          error={followupError}
        />
      ) : null}
    </div>
  );
}

function RunHeader({ live }: { live: LiveState }) {
  const stageEntries: { id: DebateStatus; label: string }[] = [
    { id: "framing", label: "Framing" },
    { id: "researching", label: "Research" },
    { id: "debating", label: "Debate" },
    { id: "judging", label: "Judging" },
    { id: "complete", label: "Done" }
  ];
  const currentIndex = stageEntries.findIndex((entry) => entry.id === live.status);

  return (
    <section className="rounded-md border border-graphite/15 bg-white p-5">
      <div className="flex flex-col gap-1 text-xs text-graphite/55">
        <span>{live.resolution ?? live.subject}</span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {stageEntries.map((stage, index) => {
          const reached =
            live.status === "complete" || index <= currentIndex || (currentIndex < 0 && stage.id === "framing");
          const active = stage.id === live.status;
          return (
            <span
              key={stage.id}
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${
                active
                  ? "border border-jade/30 bg-jade/10 text-jade"
                  : reached
                    ? "border border-graphite/15 bg-paper text-graphite/70"
                    : "border border-graphite/10 bg-white text-graphite/40"
              }`}
            >
              {active && !live.done ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              {stage.label}
            </span>
          );
        })}
      </div>
      <div className="mt-3 text-xs text-graphite/55">
        Pro {modelLabel(live.models.quick)} · Con {modelLabel(live.models.deep)} · Judge{" "}
        {modelLabel(live.models.judge)}
      </div>
    </section>
  );
}

function Verdict({ live, onRerun }: { live: LiveState; onRerun: () => void }) {
  if (!live.scorecard || !live.summary) {
    return (
      <section className="rounded-md border border-graphite/15 bg-white p-6">
        <div className="flex items-center gap-2 text-sm text-graphite/55">
          <Loader2 className="h-4 w-4 animate-spin text-jade" />
          Waiting for the verdict…
        </div>
      </section>
    );
  }

  const scorecard = live.scorecard;
  const summary = live.summary;

  return (
    <section className="rounded-md border border-graphite/15 bg-white p-6">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
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

      <div className="mt-5 flex flex-wrap items-center justify-end gap-3 border-t border-graphite/10 pt-4">
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

function ProsConsRow({ claims, status }: { claims: Claim[]; status: DebateStatus }) {
  if (claims.length === 0) {
    if (status === "queued" || status === "framing" || status === "researching") {
      return (
        <section className="grid gap-4 md:grid-cols-2">
          <ClaimSkeleton tone="pro" />
          <ClaimSkeleton tone="con" />
        </section>
      );
    }
    return null;
  }
  const pros = claims.filter((claim) => claim.side === "pro");
  const cons = claims.filter((claim) => claim.side === "con");
  return (
    <section className="grid gap-4 md:grid-cols-2">
      <ClaimCard title="Strongest pros" tone="pro" claims={pros} />
      <ClaimCard title="Strongest cons" tone="con" claims={cons} />
    </section>
  );
}

function ClaimSkeleton({ tone }: { tone: "pro" | "con" }) {
  const accent = tone === "pro" ? "text-jade" : "text-coral";
  const title = tone === "pro" ? "Strongest pros" : "Strongest cons";
  return (
    <article className="rounded-md border border-graphite/15 bg-white p-5">
      <h3 className={`text-sm font-semibold ${accent}`}>{title}</h3>
      <div className="mt-3 space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="border-l-2 border-graphite/10 pl-3">
            <div className="h-3 w-full animate-pulse rounded bg-graphite/10" />
            <div className="mt-2 h-2 w-3/4 animate-pulse rounded bg-graphite/10" />
          </div>
        ))}
      </div>
    </article>
  );
}

function ClaimCard({ title, tone, claims }: { title: string; tone: "pro" | "con"; claims: Claim[] }) {
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

function ContextRow({ summary }: { summary: DebateSummary }) {
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

/* ------------------------------ Chat-lane debate stage ------------------------------ */

function DebateStage({ live }: { live: LiveState }) {
  const grouped = useMemo(() => groupTurns(live.turns), [live.turns]);
  const roundOrder: DebateRound[] = [
    "opening",
    "cross_examination",
    "rebuttal",
    "closing",
    "judge_review",
    "synthesis"
  ];
  const orderedRounds = roundOrder.filter((round) => grouped[round]?.length);

  const isDebating = live.status === "debating";
  const isAwaitingDebate =
    live.status === "queued" || live.status === "framing" || live.status === "researching";

  return (
    <section className="rounded-md border border-graphite/15 bg-white p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-ink">Debate floor</h3>
        <div className="flex items-center gap-3 text-[11px] uppercase tracking-wide text-graphite/55">
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-jade" />
            Pro
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-coral" />
            Con
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-plum" />
            Judge
          </span>
        </div>
      </div>

      {live.teams ? <AgentRoster teams={live.teams} /> : null}

      {orderedRounds.length === 0 ? (
        <div className="mt-4 rounded-md border border-dashed border-graphite/15 bg-paper/60 p-6 text-center text-sm text-graphite/60">
          {isAwaitingDebate ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-jade" />
              Preparing the council — {stageLabel(live.status)}
            </span>
          ) : isDebating ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-jade" />
              Agents are speaking
            </span>
          ) : (
            "No turns yet."
          )}
        </div>
      ) : (
        <div className="mt-4 space-y-6">
          {orderedRounds.map((round) => (
            <div key={round}>
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-graphite/55">
                {formatRound(round)}
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {grouped[round]?.map((turn) => (
                  <TurnBubble key={turn.id} turn={turn} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function AgentRoster({ teams }: { teams: DebateTeam }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="rounded-md border border-jade/20 bg-jade/5 p-3">
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-jade">Pro lineup</div>
        <ul className="space-y-1 text-xs text-graphite">
          {teams.pro.map((agent) => (
            <li key={agent.id} className="flex flex-wrap items-center gap-1.5">
              <span className="font-semibold text-ink">{agent.name}</span>
              <span className="text-graphite/55">·</span>
              <span className="text-graphite/65">{agent.role}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="rounded-md border border-coral/20 bg-coral/5 p-3">
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-coral">Con lineup</div>
        <ul className="space-y-1 text-xs text-graphite">
          {teams.con.map((agent) => (
            <li key={agent.id} className="flex flex-wrap items-center gap-1.5">
              <span className="font-semibold text-ink">{agent.name}</span>
              <span className="text-graphite/55">·</span>
              <span className="text-graphite/65">{agent.role}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function TurnBubble({ turn }: { turn: RoundTurn }) {
  const tone =
    turn.side === "pro"
      ? "border-jade/30 bg-jade/5"
      : turn.side === "con"
        ? "border-coral/30 bg-coral/5"
        : "border-plum/30 bg-plum/5";
  const align = turn.side === "con" ? "md:col-start-2" : turn.side === "pro" ? "md:col-start-1" : "md:col-span-2";
  return (
    <article className={`rounded-md border px-4 py-3 ${tone} ${align}`}>
      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold text-ink">{turn.agentName}</span>
        <SideBadge side={turn.side} />
      </div>
      <p className="text-sm leading-relaxed text-graphite">{turn.content}</p>
    </article>
  );
}

/* ------------------------------ Shared bits ------------------------------ */

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
      {snapshots.map((snapshot, index) => (
        <div
          key={`${snapshot.id}-${index}`}
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
  followups,
  followupQuestion,
  onFollowupQuestionChange,
  onFollowupSubmit,
  isFollowupLoading,
  error
}: {
  followups: DebateRecord["followups"];
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

      {followups.length > 0 ? (
        <div className="mt-4 space-y-3">
          {followups.map((followup) => (
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

function stageLabel(status: DebateStatus): string {
  switch (status) {
    case "queued":
      return "queued";
    case "framing":
      return "framing the question";
    case "researching":
      return "gathering evidence";
    case "debating":
      return "agents are debating";
    case "judging":
      return "judge is synthesizing";
    case "complete":
      return "done";
    case "failed":
      return "failed";
    default:
      return status;
  }
}

function groupTurns(turns: RoundTurn[]) {
  return turns.reduce<Record<string, RoundTurn[]>>((groups, turn) => {
    groups[turn.round] = groups[turn.round] ?? [];
    groups[turn.round].push(turn);
    return groups;
  }, {});
}
