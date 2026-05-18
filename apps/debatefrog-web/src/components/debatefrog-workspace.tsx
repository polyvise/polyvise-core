"use client";

import { FormEvent, useEffect, useMemo, useReducer, useRef, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  RotateCcw,
  Send,
  Sparkles
} from "lucide-react";
import { Frog } from "@/components/frog";
import {
  defaultSelections,
  modelCatalog,
  slots,
  type SlotId
} from "@/lib/model-catalog";
import type {
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
  PlaceholderInfo,
  RoundTurn,
  Scorecard,
  StanceScout,
  TopicKind
} from "@polyvise/debate-engine/debate/types";

type StepId = "scouts" | "claims" | "turns" | "scorecard" | "summary";

const stepLabels: Record<StepId, string> = {
  scouts: "Stance scouts",
  claims: "Pro and con arguments",
  turns: "Debate turns",
  scorecard: "Judge scorecard",
  summary: "Final verdict"
};

const prompts = [
  "Should every meeting need a written reason to exist?",
  "Should a startup hire generalists before specialists?",
  "Should schools ban phones during the day?",
  "Should I take the higher-paying job that requires more travel?"
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
  turns: RoundTurn[];
  scorecard: Scorecard | null;
  summary: DebateSummary | null;
  snapshots: ModelSnapshot[];
  /**
   * Steps that fell back to placeholder content. When a step is here, the
   * UI must NOT render the corresponding data as a real answer.
   */
  fallbacks: Partial<Record<StepId, PlaceholderInfo>>;
  /**
   * Per-round failure info for the debate turns. A round in here means we
   * shouldn't render its bubbles — show an inline error in their place.
   */
  turnFailuresByRound: Partial<Record<DebateRound, PlaceholderInfo>>;
  errorMessage: string | null;
  done: boolean;
};

type LiveAction =
  | { type: "init"; debateId: string; subject: string; models: ModelSelections }
  | { type: "event"; event: DebateLiveEvent }
  | { type: "reset" };

function liveReducer(state: LiveState | null, action: LiveAction): LiveState | null {
  if (action.type === "reset") return null;
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
      turns: [],
      scorecard: null,
      summary: null,
      snapshots: [],
      fallbacks: {},
      turnFailuresByRound: {},
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
      return {
        ...state,
        scouts: event.scouts,
        fallbacks: mergeFallback(state.fallbacks, "scouts", event.placeholder)
      };
    case "teams":
      return { ...state, teams: event.teams };
    case "sources":
      return { ...state, sources: event.sources };
    case "claims":
      return {
        ...state,
        claims: event.claims,
        fallbacks: mergeFallback(state.fallbacks, "claims", event.placeholder)
      };
    case "turns":
      return {
        ...state,
        // Each turns event carries one round's worth; append rather than
        // replace so the lily-pad fills up incrementally.
        turns: event.placeholder ? state.turns : [...state.turns, ...event.turns],
        turnFailuresByRound: event.placeholder
          ? { ...state.turnFailuresByRound, [event.round]: event.placeholder }
          : state.turnFailuresByRound,
        fallbacks: mergeFallback(state.fallbacks, "turns", event.placeholder)
      };
    case "scorecard":
      return {
        ...state,
        scorecard: event.scorecard,
        fallbacks: mergeFallback(state.fallbacks, "scorecard", event.placeholder)
      };
    case "summary":
      return {
        ...state,
        summary: event.summary,
        fallbacks: mergeFallback(state.fallbacks, "summary", event.placeholder)
      };
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

function mergeFallback(
  current: LiveState["fallbacks"],
  step: StepId,
  placeholder: PlaceholderInfo | undefined
): LiveState["fallbacks"] {
  if (!placeholder) return current;
  return { ...current, [step]: placeholder };
}

export function DebatefrogWorkspace() {
  const [subject, setSubject] = useState(prompts[0]);
  const [context, setContext] = useState("");
  const [models, setModels] = useState<ModelSelections>(defaultSelections);
  const [showModels, setShowModels] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [debate, setDebate] = useState<DebateRecord | null>(null);
  const [live, dispatch] = useReducer(liveReducer, null);
  const [followupQuestion, setFollowupQuestion] = useState("");
  const [isFollowupLoading, setIsFollowupLoading] = useState(false);
  const [followupError, setFollowupError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  async function runDebate(event: FormEvent<HTMLFormElement>) {
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
        throw new Error(payload.error ?? "The pond is murky today. Try again.");
      }

      const seed = payload.debate;
      dispatch({ type: "init", debateId: seed.id, subject: seed.subject, models });

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
            // ignore malformed
          }
        });
      }

      const finalize = async () => {
        es.close();
        eventSourceRef.current = null;
        try {
          const finalRes = await fetch(`/api/debates/${seed.id}`, { cache: "no-store" });
          const finalPayload = (await finalRes.json()) as { debate?: DebateRecord };
          if (finalPayload.debate) setDebate(finalPayload.debate);
        } catch {
          // ignore
        }
      };

      es.addEventListener("complete", () => void finalize());
      es.addEventListener("error", () => void finalize());
      es.addEventListener("closed", () => {
        es.close();
        eventSourceRef.current = null;
      });
    } catch (caughtError) {
      setSubmitError(
        caughtError instanceof Error ? caughtError.message : "The pond is murky today. Try again."
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function askFollowup(event: FormEvent<HTMLFormElement>) {
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
      if (!response.ok) throw new Error(payload.error ?? "Couldn't answer that one.");
      const refreshed = await fetch(`/api/debates/${targetId}`, { cache: "no-store" });
      const refreshedPayload = (await refreshed.json()) as { debate: DebateRecord };
      setDebate(refreshedPayload.debate);
      setFollowupQuestion("");
    } catch (caughtError) {
      setFollowupError(
        caughtError instanceof Error ? caughtError.message : "Couldn't answer that one."
      );
    } finally {
      setIsFollowupLoading(false);
    }
  }

  function startOver() {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setDebate(null);
    dispatch({ type: "reset" });
    setSubmitError(null);
    setFollowupError(null);
    setFollowupQuestion("");
  }

  return (
    <main className="mx-auto w-full max-w-[1180px] px-4 py-6 sm:py-10">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3 text-pond">
          <Frog mood="idle" size={42} />
          <span className="text-lg font-black tracking-tight">Debatefrog</span>
        </div>
        {live ? (
          <button
            type="button"
            onClick={startOver}
            className="inline-flex items-center gap-1.5 rounded-full bg-white/70 px-3 py-1.5 text-xs font-bold text-pond shadow-sm transition hover:bg-white"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Fresh pond
          </button>
        ) : null}
      </header>

      {!live ? (
        <PondHero
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
          onSubmit={runDebate}
        />
      ) : (
        <LiveView
          live={live}
          finalRecord={debate}
          followupQuestion={followupQuestion}
          onFollowupQuestionChange={setFollowupQuestion}
          onFollowupSubmit={askFollowup}
          isFollowupLoading={isFollowupLoading}
          followupError={followupError}
        />
      )}
    </main>
  );
}

/* ------------------------------ Pond hero ------------------------------ */

function PondHero({
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
    <section className="mt-6 grid gap-8 lg:mt-12 lg:grid-cols-[minmax(0,1fr)_minmax(360px,460px)]">
      <div className="flex flex-col justify-center">
        <h1 className="font-black leading-[0.95] text-pond" style={{ fontSize: "clamp(3rem, 8vw, 5.8rem)" }}>
          Drop a question
          <br />
          in the pond.
        </h1>
        <p className="mt-5 max-w-[540px] text-lg leading-relaxed text-ink/75">
          Two frogs argue it out. A judge frog calls the verdict. You watch the whole debate happen,
          turn by turn.
        </p>
        <div className="mt-6 hidden gap-3 sm:flex">
          <Frog mood="pro" size={70} />
          <Frog mood="con" size={70} />
          <Frog mood="judge" size={70} />
        </div>
      </div>

      <form
        onSubmit={onSubmit}
        className="rounded-2xl border border-mud/20 bg-panel/90 p-5 shadow-lily backdrop-blur"
      >
        <label htmlFor="subject" className="text-sm font-extrabold text-mud">
          Your question
        </label>
        <textarea
          id="subject"
          value={subject}
          onChange={(event) => onSubjectChange(event.target.value)}
          placeholder="Should...?"
          className="mt-1.5 min-h-[110px] w-full resize-y rounded-xl border border-mud/20 bg-white/90 px-3.5 py-3 text-base leading-relaxed text-ink outline-none transition focus:border-leaf"
        />

        <label htmlFor="context" className="mt-4 block text-sm font-extrabold text-mud">
          A little context <span className="font-normal text-ink/50">(optional)</span>
        </label>
        <textarea
          id="context"
          value={context}
          onChange={(event) => onContextChange(event.target.value)}
          placeholder="Audience, constraints, stakes, or what sparked the question."
          className="mt-1.5 min-h-[80px] w-full resize-y rounded-xl border border-mud/20 bg-white/90 px-3.5 py-3 text-sm leading-relaxed text-ink outline-none transition focus:border-leaf"
        />

        <ModelPicker
          models={models}
          onModelsChange={onModelsChange}
          open={showModels}
          onToggle={onToggleModels}
        />

        {error ? (
          <div className="mt-4 rounded-xl border border-berry/40 bg-berry/10 px-3 py-2.5 text-sm text-berry">
            {error}
          </div>
        ) : null}

        <button
          type="submit"
          disabled={isSubmitting || subject.trim().length < 4}
          className="mt-4 inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-pond to-leafDark px-4 text-sm font-black text-white shadow-lily transition hover:opacity-95 disabled:cursor-not-allowed disabled:bg-mud/30 disabled:from-mud/30 disabled:to-mud/30 disabled:shadow-none"
        >
          {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          Start the debate
        </button>

        <div className="mt-5">
          <div className="mb-2 text-[11px] font-extrabold uppercase tracking-wide text-mud/70">
            Try one of these
          </div>
          <div className="flex flex-wrap gap-2">
            {prompts.map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={() => onSubjectChange(prompt)}
                className="rounded-full border border-pond/15 bg-white/70 px-3 py-1.5 text-xs font-semibold text-pond transition hover:bg-mint"
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-5 border-t border-mud/10 pt-3 text-center">
          <Link
            // typed-routes generates the route map at build time; cast keeps
            // tsc happy in CI where .next/types may be stale.
            href={"/" as Route}
            className="inline-flex items-center gap-1 text-xs font-semibold text-pond/70 transition hover:text-pond"
          >
            <span aria-hidden="true">→</span>
            <span>Back to Froglings</span>
          </Link>
        </div>
      </form>
    </section>
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
    <div className="mt-4 rounded-xl border border-mud/20 bg-white/90">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-3.5 py-2.5 text-left"
      >
        <span className="flex flex-wrap items-center gap-2 text-sm font-bold text-mud">
          <Sparkles className="h-4 w-4 text-sun" />
          Frog brains
          <span className="text-xs font-normal text-ink/55">
            {modelLabel(models.quick)} · {modelLabel(models.deep)} · {modelLabel(models.judge)}
          </span>
        </span>
        {open ? (
          <ChevronUp className="h-4 w-4 text-mud/60" />
        ) : (
          <ChevronDown className="h-4 w-4 text-mud/60" />
        )}
      </button>
      {open ? (
        <div className="border-t border-mud/10 p-3.5">
          <div className="grid gap-3 sm:grid-cols-3">
            {slots.map((slot) => (
              <div key={slot.id}>
                <label htmlFor={`fmodel-${slot.id}`} className="mb-1 block text-xs font-bold text-mud">
                  {slot.title}
                </label>
                <select
                  id={`fmodel-${slot.id}`}
                  value={models[slot.id]}
                  onChange={(event) =>
                    onModelsChange({ ...models, [slot.id]: event.target.value })
                  }
                  className="w-full rounded-lg border border-mud/20 bg-white px-2.5 py-2 text-sm text-ink outline-none transition focus:border-leaf"
                >
                  {modelCatalog.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                      {option.notes ? ` — ${option.notes}` : ""}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] leading-snug text-ink/55">{slot.description}</p>
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
  followupError
}: {
  live: LiveState;
  finalRecord: DebateRecord | null;
  followupQuestion: string;
  onFollowupQuestionChange: (value: string) => void;
  onFollowupSubmit: (event: FormEvent<HTMLFormElement>) => void;
  isFollowupLoading: boolean;
  followupError: string | null;
}) {
  const isComplete = live.done && live.status === "complete";
  const isFailed = live.status === "failed";
  const fallbackSteps = Object.keys(live.fallbacks) as StepId[];
  const verdictFellBack = Boolean(live.fallbacks.scorecard || live.fallbacks.summary);
  const claimsFellBack = Boolean(live.fallbacks.claims);
  const summaryFellBack = Boolean(live.fallbacks.summary);

  return (
    <div className="mt-6 space-y-5">
      <RunHeader live={live} />

      {isFailed ? (
        <div className="rounded-xl border border-berry/40 bg-berry/10 px-4 py-3 text-sm text-berry">
          {live.errorMessage ?? "The debate hopped off a lily pad."}
        </div>
      ) : null}

      {fallbackSteps.length > 0 ? <FallbackBanner live={live} steps={fallbackSteps} /> : null}

      {verdictFellBack ? <VerdictUnavailable live={live} /> : <Verdict live={live} />}

      <FrogStage live={live} />

      {claimsFellBack ? (
        <SectionUnavailable title="Pros and cons unavailable" info={live.fallbacks.claims!} />
      ) : (
        <ProsCons live={live} />
      )}

      {summaryFellBack ? null : live.summary ? <Context live={live} /> : null}

      {live.sources.length > 0 ? (
        <Disclosure title={`Sources (${live.sources.length})`}>
          <Sources sources={live.sources} />
        </Disclosure>
      ) : null}

      {live.snapshots.length > 0 ? (
        <Disclosure title="Frog brain stats">
          <Snapshots snapshots={live.snapshots} />
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

function FallbackBanner({ live, steps }: { live: LiveState; steps: StepId[] }) {
  return (
    <section className="rounded-2xl border border-berry/40 bg-berry/10 p-4 shadow-pop">
      <h3 className="text-sm font-black text-berry">
        {steps.length === 1
          ? "One frog couldn't speak with your chosen brain"
          : `${steps.length} frogs couldn't speak with your chosen brains`}
      </h3>
      <p className="mt-1 text-sm leading-relaxed text-ink/80">
        Rather than fake those parts, the affected sections below are hidden. Pick different models
        and try again.
      </p>
      <ul className="mt-3 space-y-1.5 text-sm text-ink/85">
        {steps.map((step) => {
          const info = live.fallbacks[step]!;
          return (
            <li key={step} className="border-l-2 border-berry/50 pl-3">
              <span className="font-bold text-ink">{stepLabels[step]}</span>
              <span className="text-ink/65"> — asked </span>
              <code className="rounded bg-white/80 px-1 py-0.5 text-xs font-mono text-ink">
                {info.requestedModel}
              </code>
              <div className="mt-0.5 text-xs text-ink/65">{info.reason}</div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function VerdictUnavailable({ live }: { live: LiveState }) {
  const reasons: { label: string; info: PlaceholderInfo }[] = [];
  if (live.fallbacks.scorecard) reasons.push({ label: "Scorecard", info: live.fallbacks.scorecard });
  if (live.fallbacks.summary) reasons.push({ label: "Summary", info: live.fallbacks.summary });
  return (
    <section className="rounded-2xl border border-berry/40 bg-panel/95 p-6 shadow-lily">
      <div className="flex items-start gap-3">
        <Frog mood="judge" size={56} />
        <div className="min-w-0">
          <h2 className="text-xl font-black text-pond">The judge frog couldn't deliver a verdict</h2>
          <p className="mt-1 text-sm leading-relaxed text-ink/80">
            Your selected judge model didn't return a usable response, so there's no verdict to
            show. The hardcoded placeholder built into the engine is not a real answer and won't be
            displayed here.
          </p>
          <ul className="mt-3 space-y-1.5 text-sm text-ink/85">
            {reasons.map(({ label, info }) => (
              <li key={label} className="border-l-2 border-berry/50 pl-3">
                <span className="font-bold text-ink">{label}</span>
                <span className="text-ink/65"> — asked </span>
                <code className="rounded bg-cream/60 px-1 py-0.5 text-xs font-mono text-ink">
                  {info.requestedModel}
                </code>
                <div className="mt-0.5 text-xs text-ink/65">{info.reason}</div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function SectionUnavailable({ title, info }: { title: string; info: PlaceholderInfo }) {
  return (
    <section className="rounded-2xl border border-berry/30 bg-panel/95 p-5 shadow-sm">
      <h3 className="text-sm font-black text-berry">{title}</h3>
      <p className="mt-1 text-sm leading-relaxed text-ink/80">
        Asked{" "}
        <code className="rounded bg-cream/60 px-1 py-0.5 text-xs font-mono text-ink">
          {info.requestedModel}
        </code>{" "}
        but it didn't return a usable response, so this section is empty rather than filled with
        placeholder text.
      </p>
      <p className="mt-2 text-xs text-ink/65">{info.reason}</p>
    </section>
  );
}

function RunHeader({ live }: { live: LiveState }) {
  const stageEntries: { id: DebateStatus; label: string }[] = [
    { id: "framing", label: "Framing" },
    { id: "researching", label: "Hopping for sources" },
    { id: "debating", label: "Debating" },
    { id: "judging", label: "Verdict" },
    { id: "complete", label: "Done" }
  ];
  const currentIndex = stageEntries.findIndex((entry) => entry.id === live.status);

  return (
    <section className="rounded-2xl border border-mud/20 bg-panel/90 p-5 shadow-lily backdrop-blur">
      <div className="text-xs font-bold uppercase tracking-wide text-mud/60">Question</div>
      <div className="mt-1 text-base leading-snug text-ink">
        {stripResolvedPrefix(live.resolution ?? live.subject)}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {stageEntries.map((stage, index) => {
          const reached =
            live.status === "complete" || index <= currentIndex || (currentIndex < 0 && stage.id === "framing");
          const active = stage.id === live.status;
          return (
            <span
              key={stage.id}
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold ${
                active
                  ? "border border-pond/40 bg-pond/15 text-pond"
                  : reached
                    ? "border border-mud/20 bg-white text-mud/80"
                    : "border border-mud/15 bg-white/60 text-mud/40"
              }`}
            >
              {active && !live.done ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              {stage.label}
            </span>
          );
        })}
      </div>
      <div className="mt-3 text-xs text-ink/55">
        Pro {modelLabel(live.models.quick)} · Con {modelLabel(live.models.deep)} · Judge{" "}
        {modelLabel(live.models.judge)}
      </div>
    </section>
  );
}

function Verdict({ live }: { live: LiveState }) {
  if (!live.scorecard || !live.summary) {
    return (
      <section className="rounded-2xl border border-mud/20 bg-panel/90 p-5 shadow-lily">
        <div className="flex items-center gap-3 text-sm text-mud/70">
          <Frog mood={live.status === "judging" ? "judge" : "idle"} size={48} />
          {verdictPendingCopy(live.status)}
        </div>
      </section>
    );
  }
  const scorecard = live.scorecard;
  const summary = live.summary;
  const pct = Math.round(scorecard.confidence * 100);

  return (
    <section className="rounded-2xl border border-mud/20 bg-panel/95 p-6 shadow-lily">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4 sm:max-w-xl">
          <div className="flex shrink-0 flex-col items-center gap-1">
            <Frog mood="judge" size={64} />
            <span className="rounded-full bg-[#9978b8]/15 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-[#5c4583]">
              Judge
            </span>
          </div>
          <div>
            <span
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-black ${recommendationToneClass(scorecard.recommendation)}`}
            >
              {formatRecommendation(scorecard.recommendation)}
            </span>
            <h2 className="mt-3 text-2xl font-black leading-snug text-pond">
              {stripResolvedPrefix(summary.headline)}
            </h2>
            <p className="mt-2 text-base leading-relaxed text-ink/85">
              {stripResolvedPrefix(summary.recommendation)}
            </p>
          </div>
        </div>
        <div className="flex flex-col items-end">
          <div className="text-[11px] font-bold uppercase tracking-wide text-mud/60">Confidence</div>
          <div className="mt-1 text-3xl font-black tabular-nums text-pond">{pct}%</div>
          <div className="mt-1 h-1.5 w-32 overflow-hidden rounded-full bg-mud/15">
            <div className="h-full bg-leaf" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>

      {summary.highStakesDisclaimer ? (
        <div className="mt-4 rounded-xl border border-sun/50 bg-sun/15 px-3 py-2.5 text-sm text-ink/85">
          {summary.highStakesDisclaimer}
        </div>
      ) : null}
    </section>
  );
}

/* ------------------------------ Frog chat stage ------------------------------ */

function FrogStage({ live }: { live: LiveState }) {
  const grouped = useMemo(() => groupTurns(live.turns), [live.turns]);
  const roundOrder: DebateRound[] = [
    "opening",
    "cross_examination",
    "rebuttal",
    "closing",
    "judge_review",
    "synthesis"
  ];
  const presentRounds = roundOrder.filter(
    (round) => grouped[round]?.length || live.turnFailuresByRound[round]
  );

  const isAwaitingDebate =
    live.status === "queued" || live.status === "framing" || live.status === "researching";
  const isDebating = live.status === "debating";

  return (
    <section className="rounded-2xl border border-mud/20 bg-panel/90 p-5 shadow-lily">
      <h3 className="mb-4 text-sm font-black text-pond">Lily pad debate</h3>

      {live.teams ? <Lineup teams={live.teams} /> : null}

      {presentRounds.length === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-mud/25 bg-cream/40 p-6 text-center text-sm text-ink/65">
          {isAwaitingDebate ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-leaf" />
              The frogs are getting ready — {stageLabel(live.status)}
            </span>
          ) : (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-leaf" />
              The frogs are warming up
            </span>
          )}
        </div>
      ) : (
        <div className="mt-4 space-y-6">
          {presentRounds.map((round) => {
            const failure = live.turnFailuresByRound[round];
            const turns = grouped[round] ?? [];
            return (
              <div key={round}>
                <div className="mb-2 inline-flex items-center gap-2 rounded-full bg-cream/70 px-3 py-1 text-[11px] font-black uppercase tracking-wide text-mud">
                  {formatRound(round)}
                </div>
                {failure ? (
                  <RoundFailedInline info={failure} />
                ) : (
                  <div className="grid gap-3 md:grid-cols-2">
                    {turns.map((turn, index) => (
                      <TurnBubble key={turn.id} turn={turn} index={index} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {isDebating ? <NextRoundComing /> : null}
        </div>
      )}
    </section>
  );
}

function RoundFailedInline({ info }: { info: PlaceholderInfo }) {
  return (
    <div className="rounded-xl border border-berry/30 bg-berry/10 p-3 text-sm text-ink/85">
      <div className="text-sm font-black text-berry">This round didn't run</div>
      <div className="mt-0.5 text-xs text-ink/70">
        Asked{" "}
        <code className="rounded bg-white/80 px-1 py-0.5 font-mono text-[11px] text-ink">
          {info.requestedModel}
        </code>{" "}
        but it didn't return a usable response.
      </div>
      <div className="mt-0.5 text-xs text-ink/60">{info.reason}</div>
    </div>
  );
}

function NextRoundComing() {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-dashed border-leaf/40 bg-mint/40 px-3 py-1.5 text-xs font-bold text-pond">
      <Loader2 className="h-3 w-3 animate-spin text-leaf" />
      Next round hopping in…
    </div>
  );
}

function Lineup({ teams }: { teams: DebateTeam }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="flex items-center gap-3 rounded-xl border border-leaf/30 bg-mint/40 p-3">
        <Frog mood="pro" size={48} />
        <div className="min-w-0">
          <div className="text-[11px] font-black uppercase tracking-wide text-pond">Pro frogs</div>
          <ul className="mt-0.5 space-y-0.5 text-xs text-ink/80">
            {teams.pro.map((agent) => (
              <li key={agent.id} className="truncate">
                <span className="font-bold">{agent.name}</span>
                <span className="text-ink/55"> · {agent.role}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="flex items-center gap-3 rounded-xl border border-berry/30 bg-lily/40 p-3">
        <Frog mood="con" size={48} />
        <div className="min-w-0">
          <div className="text-[11px] font-black uppercase tracking-wide text-berry">Con frogs</div>
          <ul className="mt-0.5 space-y-0.5 text-xs text-ink/80">
            {teams.con.map((agent) => (
              <li key={agent.id} className="truncate">
                <span className="font-bold">{agent.name}</span>
                <span className="text-ink/55"> · {agent.role}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function TurnBubble({ turn, index = 0 }: { turn: RoundTurn; index?: number }) {
  const isPro = turn.side === "pro";
  const isCon = turn.side === "con";
  const mood: "pro" | "con" | "judge" = isPro ? "pro" : isCon ? "con" : "judge";
  const tone = isPro
    ? "border-leaf/30 bg-mint/50"
    : isCon
      ? "border-berry/30 bg-lily/40"
      : "border-[#9978b8]/30 bg-[#ece4f5]/60";
  const align = isCon ? "md:col-start-2" : isPro ? "md:col-start-1" : "md:col-span-2";
  return (
    <article
      className={`hop-in flex gap-3 rounded-2xl border px-4 py-3 ${tone} ${align}`}
      style={{ animationDelay: `${index * 280}ms` }}
    >
      <div className="shrink-0">
        <Frog mood={mood} size={44} speaking />
      </div>
      <div className="min-w-0">
        <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="font-black text-ink">{turn.agentName}</span>
          <span
            className={`rounded-full px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wide ${
              isPro
                ? "bg-leaf/15 text-pond"
                : isCon
                  ? "bg-berry/15 text-berry"
                  : "bg-[#9978b8]/15 text-[#5c4583]"
            }`}
          >
            {turn.side}
          </span>
        </div>
        <p className="text-sm leading-relaxed text-ink/85">{stripResolvedPrefix(turn.content)}</p>
      </div>
    </article>
  );
}

/* ------------------------------ Pros / Cons / Context ------------------------------ */

function ProsCons({ live }: { live: LiveState }) {
  if (live.claims.length === 0) {
    if (live.status === "queued" || live.status === "framing" || live.status === "researching") {
      return (
        <section className="grid gap-3 md:grid-cols-2">
          <ClaimSkeleton tone="pro" />
          <ClaimSkeleton tone="con" />
        </section>
      );
    }
    return null;
  }
  const pros = live.claims.filter((claim) => claim.side === "pro");
  const cons = live.claims.filter((claim) => claim.side === "con");
  return (
    <section className="grid gap-3 md:grid-cols-2">
      <ClaimCard title="Best yes case" tone="pro" claims={pros} />
      <ClaimCard title="Best no case" tone="con" claims={cons} />
    </section>
  );
}

function ClaimSkeleton({ tone }: { tone: "pro" | "con" }) {
  const title = tone === "pro" ? "Best yes case" : "Best no case";
  const accent = tone === "pro" ? "text-pond" : "text-berry";
  return (
    <article className="rounded-2xl border border-mud/20 bg-panel/90 p-5 shadow-sm">
      <h3 className={`text-sm font-black ${accent}`}>{title}</h3>
      <div className="mt-3 space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="border-l-2 border-mud/15 pl-3">
            <div className="h-3 w-full animate-pulse rounded bg-mud/15" />
            <div className="mt-2 h-2 w-3/4 animate-pulse rounded bg-mud/15" />
          </div>
        ))}
      </div>
    </article>
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
  const accent = tone === "pro" ? "text-pond" : "text-berry";
  return (
    <article className="rounded-2xl border border-mud/20 bg-panel/90 p-5 shadow-sm">
      <h3 className={`text-sm font-black ${accent}`}>{title}</h3>
      <ul className="mt-3 space-y-3">
        {claims.map((claim) => (
          <li key={claim.id} className="border-l-2 border-mud/15 pl-3">
            <p className="text-sm font-bold leading-relaxed text-ink">{stripResolvedPrefix(claim.text)}</p>
            <p className="mt-1 text-xs leading-relaxed text-ink/65">{stripResolvedPrefix(claim.warrant)}</p>
          </li>
        ))}
      </ul>
    </article>
  );
}

function Context({ live }: { live: LiveState }) {
  const summary = live.summary!;
  return (
    <section className="grid gap-3 md:grid-cols-2">
      <article className="rounded-2xl border border-mud/20 bg-panel/90 p-5 shadow-sm">
        <h3 className="text-sm font-black text-mud">Still wondering about…</h3>
        <ul className="mt-3 space-y-2 text-sm leading-relaxed text-ink/85">
          {summary.unresolvedUncertainties.map((item) => (
            <li key={item} className="border-l-2 border-mud/15 pl-3">
              {item}
            </li>
          ))}
        </ul>
      </article>
      <article className="rounded-2xl border border-mud/20 bg-panel/90 p-5 shadow-sm">
        <h3 className="text-sm font-black text-mud">What would change the answer</h3>
        <ul className="mt-3 space-y-2 text-sm leading-relaxed text-ink/85">
          {summary.whatWouldChangeMind.map((item) => (
            <li key={item} className="border-l-2 border-mud/15 pl-3">
              {item}
            </li>
          ))}
        </ul>
      </article>
    </section>
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
    <section className="rounded-2xl border border-mud/20 bg-panel/90 shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-5 py-3 text-left"
      >
        <span className="text-sm font-black text-pond">{title}</span>
        {open ? (
          <ChevronUp className="h-4 w-4 text-mud/60" />
        ) : (
          <ChevronDown className="h-4 w-4 text-mud/60" />
        )}
      </button>
      {open ? <div className="border-t border-mud/10 p-5">{children}</div> : null}
    </section>
  );
}

function Sources({ sources }: { sources: EvidenceSource[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {sources.map((source) => (
        <a
          key={source.id}
          href={source.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-full bg-mint px-3 py-1.5 text-xs font-bold text-pond transition hover:bg-mint/70"
          title={source.title}
        >
          {source.publisher}
        </a>
      ))}
    </div>
  );
}

function Snapshots({ snapshots }: { snapshots: ModelSnapshot[] }) {
  return (
    <div className="space-y-2">
      {snapshots.map((snapshot, index) => {
        const failed = Boolean(snapshot.failure);
        return (
          <div
            key={`${snapshot.id}-${index}`}
            className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2 ${
              failed ? "border-berry/40 bg-berry/10" : "border-mud/15 bg-cream/30"
            }`}
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-sm font-bold text-ink">
                <span>{snapshot.model}</span>
                {failed ? (
                  <span className="rounded-full border border-berry/40 bg-white px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wide text-berry">
                    Fallback
                  </span>
                ) : null}
              </div>
              <div className="text-xs text-ink/60">{snapshot.role}</div>
              {snapshot.failure ? (
                <div className="mt-1 text-xs text-berry">{snapshot.failure}</div>
              ) : null}
            </div>
            <div className="text-xs text-ink/60">
              {snapshot.latencyMs ? `${snapshot.latencyMs}ms` : null}
            </div>
          </div>
        );
      })}
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
    <section className="rounded-2xl border border-mud/20 bg-panel/90 p-5 shadow-lily">
      <h3 className="text-sm font-black text-pond">Ask the frogs a follow-up</h3>
      <form onSubmit={onFollowupSubmit} className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          value={followupQuestion}
          onChange={(event) => onFollowupQuestionChange(event.target.value)}
          placeholder="What's the biggest risk? What would change your mind?"
          className="h-11 flex-1 rounded-xl border border-mud/20 bg-white px-3 text-sm text-ink outline-none transition focus:border-leaf"
        />
        <button
          type="submit"
          disabled={isFollowupLoading || followupQuestion.trim().length < 4}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-pond to-leafDark px-4 text-sm font-black text-white shadow-lily transition disabled:cursor-not-allowed disabled:bg-mud/30 disabled:from-mud/30 disabled:to-mud/30 disabled:shadow-none"
        >
          {isFollowupLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          Ask
        </button>
      </form>

      {error ? (
        <div className="mt-3 rounded-xl border border-berry/40 bg-berry/10 px-3 py-2 text-sm text-berry">
          {error}
        </div>
      ) : null}

      {followups.length > 0 ? (
        <div className="mt-4 space-y-3">
          {followups.map((followup) => (
            <div key={followup.id} className="rounded-xl border border-mud/15 bg-cream/30 p-3">
              <div className="text-sm font-bold text-ink">{followup.question}</div>
              <p className="mt-1 text-sm leading-relaxed text-ink/75">{followup.answer}</p>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function recommendationToneClass(rec: Scorecard["recommendation"]): string {
  switch (rec) {
    case "lean_yes":
    case "conditional_yes":
      return "border-leaf/40 bg-mint text-pond";
    case "lean_no":
    case "conditional_no":
      return "border-berry/40 bg-lily/60 text-berry";
    case "mixed":
    default:
      return "border-sun/50 bg-sun/20 text-mud";
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
      return "hopping for sources";
    case "debating":
      return "the lily pad is loud";
    case "judging":
      return "the judge is deliberating";
    case "complete":
      return "done";
    case "failed":
      return "fell off";
    default:
      return status;
  }
}

function verdictPendingCopy(status: DebateStatus): string {
  switch (status) {
    case "queued":
    case "framing":
      return "The frogs are framing the question…";
    case "researching":
      return "The frogs are gathering sources…";
    case "debating":
      return "The frogs are making their cases…";
    case "judging":
      return "The judge frog is weighing the arguments…";
    case "failed":
      return "The judge frog couldn't deliver a verdict.";
    default:
      return "The frogs are getting ready…";
  }
}

function stripResolvedPrefix(text: string): string {
  return text
    .replace(/(["“])Resolved:\s*([^"”]+?)(\.?)(["”])/gi, (_match, open: string, question: string, _period: string, close: string) => {
      const cleaned = question.trim().replace(/[.!?]+$/, "");
      return `${open}${/^should\b/i.test(cleaned) ? `${cleaned}?` : cleaned}${close}`;
    })
    .replace(/\bResolved:\s*/gi, "");
}

function groupTurns(turns: RoundTurn[]) {
  return turns.reduce<Record<string, RoundTurn[]>>((groups, turn) => {
    groups[turn.round] = groups[turn.round] ?? [];
    groups[turn.round].push(turn);
    return groups;
  }, {});
}
