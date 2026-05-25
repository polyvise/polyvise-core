"use client";

/**
 * FroglingsWorkspace — the "funner version" of Debatefrog aimed at younger
 * viewers. Consumes the SAME /api/debates POST + SSE stream as the main
 * Debatefrog app, but hardcodes `councilSize: "duo"` so the engine returns
 * a 1-on-1 debate (one pro frog, one con frog, one judge), and renders the
 * stream in a simpler, more playful layout.
 *
 * Layered up across phases:
 *  - Phase 3: bones — kid prompts, plain-language stage labels, single
 *             pro/con bubbles per round, simple verdict.
 *  - Phase 4: FunFrog animation (bob, blink, mouth chatter, hop).
 *  - Phase 5: SlowPrint typewriter driving the mouth-chatter signal.
 *  - Phase 6: useFrogSounds() chirp/croak audio + header mute toggle.
 *  - Phase 7: first-visit FroglingsIntro overlay (localStorage-gated)
 *             + per-round explainer banner on the live stage.
 */

const INTRO_SEEN_KEY = "froglings:intro-seen";
const MODEL_SETTINGS_KEY = "froglings:model-settings:v3";
const USER_PREFERENCES_KEY = "froglings:user-preferences";
const isPreviewDeploy = process.env.NEXT_PUBLIC_DEPLOY_CHANNEL === "preview";

import {
  createContext,
  FormEvent,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState
} from "react";
import Link from "next/link";
import type { Route } from "next";
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  Loader2,
  RotateCcw,
  Send,
  Settings,
  SlidersHorizontal,
  Volume2,
  VolumeX,
  X
} from "lucide-react";
import { FunFrog } from "@/components/fun-frog";
import { SlowPrint } from "@/components/slow-print";
import { useFrogSounds } from "@/components/use-frog-sounds";
import { FroglingsIntro } from "@/components/froglings-intro";
import type {
  Claim,
  DebateLiveEvent,
  DebateRecord,
  DebateRound,
  DebateRun,
  DebateStatus,
  DebateSummary,
  DebateTeam,
  EvidenceSource,
  ModelSnapshot,
  RunTraceEntry,
  TopicKind,
  RoundTurn,
  Scorecard,
  PlaceholderInfo
} from "@polyvise/debate-engine/debate/types";

const kidPrompts = [
  "Should schools have longer recess?",
  "Should kids be allowed to vote?",
  "Should video games count as exercise?",
  "Should pets be allowed at school?",
  "Should homework be banned?"
];

type StartCountdownCue = {
  delayMs: number;
  frequency: number;
  durationMs: number;
  gain?: number;
};

const START_SEQUENCE_MIN_MS = 5500;
const START_COUNTDOWN_TITLE_DELAY_MS = 650;
const START_COUNTDOWN_CUES: StartCountdownCue[] = [
  { delayMs: 700, frequency: 660, durationMs: 120 },
  { delayMs: 2100, frequency: 660, durationMs: 120 },
  { delayMs: 3300, frequency: 660, durationMs: 120 },
  { delayMs: 4500, frequency: 920, durationMs: 520, gain: 0.13 }
];
const DEBATE_UNAVAILABLE_MESSAGE =
  "The frogs couldn't start a debate right now. Please try again in a few minutes.";
const CLIENT_API_MAX_ATTEMPTS = 3;
const CLIENT_API_RETRY_BASE_DELAY_MS = 500;

type ModelRole = "yes" | "no" | "judge";
type ModelSelections = Record<ModelRole, string>;
type ModelOption = { id: string; label: string };
type ModelOptionsResponse = {
  defaults: ModelSelections;
  options: ModelOption[];
  dev?: {
    liveApiToggleAvailable: boolean;
    hasOpenRouterKey: boolean;
    hasTavilyKey: boolean;
  };
};
type UserPreferences = {
  openingSplash: boolean;
  liveApisInDev: boolean;
};
const defaultUserPreferences: UserPreferences = {
  openingSplash: true,
  liveApisInDev: false
};
type ApiCallTiming = {
  id: string;
  label: string;
  detail: string;
  durationMs: number;
  status?: "ok" | "failed";
  children?: ApiCallTiming[];
};

/**
 * Plain-language stage labels for younger readers. The engine emits the
 * same DebateStatus values as the engine — we just rename them.
 */
const friendlyStage: Record<DebateStatus, string> = {
  queued: "the frogs are getting ready",
  framing: "the frogs are reading the question",
  researching: "the frogs are looking up facts",
  debating: "the frogs are arguing!",
  judging: "the judge frog is thinking",
  complete: "debate finished",
  failed: "uh oh — the frogs slipped off the lily pad",
  partial: "the frogs only got part way"
};

/**
 * Plain-language round labels. Matches DebateRound from the engine.
 */
const friendlyRound: Record<DebateRound, { title: string; blurb: string }> = {
  opening: {
    title: "Round 1 — Opening",
    blurb: "Each frog says what they think."
  },
  cross_examination: {
    title: "Round 2 — Tough Questions",
    blurb: "Each frog asks the other tricky questions."
  },
  rebuttal: {
    title: "Round 3 — Comeback",
    blurb: "Each frog answers back to defend their side."
  },
  closing: {
    title: "Round 4 — Last Word",
    blurb: "Each frog says why they should win."
  },
  judge_review: {
    title: "Judge's Notes",
    blurb: "The judge frog jots down what stood out."
  },
  synthesis: {
    title: "Wrap-up",
    blurb: "Putting it all together."
  }
};

// -------------------------------------------------------------------------
// Live state — keep only the fields this UI renders.
// -------------------------------------------------------------------------

type FroglingsLiveState = {
  debateId: string;
  subject: string;
  status: DebateStatus;
  resolution?: string;
  topicKind?: TopicKind;
  teams: DebateTeam | null;
  claims: Claim[];
  sources: EvidenceSource[];
  turns: RoundTurn[];
  scorecard: Scorecard | null;
  summary: DebateSummary | null;
  errorMessage: string | null;
  backupReasons: string[];
  modelSnapshots: ModelSnapshot[];
  trace: RunTraceEntry[];
  done: boolean;
};

type LiveAction =
  | { type: "init"; debateId: string; subject: string }
  | { type: "event"; event: DebateLiveEvent }
  | { type: "hydrate"; debate: DebateRecord }
  | { type: "reset" };

function liveReducer(state: FroglingsLiveState | null, action: LiveAction): FroglingsLiveState | null {
  if (action.type === "reset") return null;
  if (action.type === "init") {
    return {
      debateId: action.debateId,
      subject: action.subject,
      status: "queued",
      teams: null,
      claims: [],
      sources: [],
      turns: [],
      scorecard: null,
      summary: null,
      errorMessage: null,
      backupReasons: [],
      modelSnapshots: [],
      trace: [],
      done: false
    };
  }
  if (action.type === "hydrate") {
    const run = action.debate.latestRun;
    if (!run) return state;
    return {
      debateId: action.debate.id,
      subject: action.debate.subject,
      status: action.debate.status,
      resolution: action.debate.resolution,
      topicKind: action.debate.topicKind,
      teams: run.teams,
      claims: run.claims,
      sources: run.sources,
      turns: run.turns,
      scorecard: run.scorecard,
      summary: run.summary,
      errorMessage: null,
      backupReasons: backupReasonsFromRun(run),
      modelSnapshots: run.modelSnapshots,
      trace: run.trace,
      done: action.debate.status === "complete" || action.debate.status === "failed"
    };
  }
  if (!state) return state;
  const event = action.event;
  switch (event.kind) {
    case "stage":
      return { ...state, status: event.status };
    case "framed":
      return { ...state, resolution: event.resolution, topicKind: event.topicKind };
    case "teams":
      return { ...state, teams: event.teams };
    case "sources":
      return { ...state, sources: event.sources };
    case "claims":
      // In duo mode placeholder fallbacks would be a corner case; the
      // funner UI hides claims rather than showing fallback text.
      return event.placeholder
        ? addBackupReason(state, event.placeholder)
        : { ...state, claims: event.claims };
    case "turns":
      return event.placeholder
        ? addBackupReason(state, event.placeholder)
        : { ...state, turns: [...state.turns, ...event.turns] };
    case "scorecard":
      return event.placeholder
        ? addBackupReason(state, event.placeholder)
        : { ...state, scorecard: event.scorecard };
    case "summary":
      return event.placeholder
        ? addBackupReason(state, event.placeholder)
        : { ...state, summary: event.summary };
    case "model_snapshot":
      if (isBackupSnapshot(event.snapshot)) {
        return addBackupReason(state, {
          requestedModel: event.snapshot.model,
          reason: event.snapshot.failure ?? "The dev server used local backup model text."
        });
      }
      return { ...state, modelSnapshots: upsertModelSnapshot(state.modelSnapshots, event.snapshot) };
    case "complete":
      return { ...state, status: "complete", done: true };
    case "error":
      return { ...state, status: "failed", done: true, errorMessage: event.message };
    default:
      return state;
  }
}

function addBackupReason(state: FroglingsLiveState, placeholder: PlaceholderInfo): FroglingsLiveState {
  const reason = `${placeholder.requestedModel}: ${placeholder.reason}`;
  const currentReasons = state.backupReasons ?? [];
  if (currentReasons.includes(reason)) return state;
  return { ...state, backupReasons: [...currentReasons, reason] };
}

function upsertModelSnapshot(snapshots: ModelSnapshot[], next: ModelSnapshot): ModelSnapshot[] {
  const existingIndex = snapshots.findIndex((snapshot) => snapshot.id === next.id);
  if (existingIndex === -1) return [...snapshots, next];
  return snapshots.map((snapshot, index) => (index === existingIndex ? next : snapshot));
}

function backupReasonsFromRun(run: DebateRun): string[] {
  return run.modelSnapshots
    .filter(isBackupSnapshot)
    .map((snapshot) => `${snapshot.model}: ${snapshot.failure ?? "The dev server used local backup model text."}`)
    .filter((reason, index, reasons) => reasons.indexOf(reason) === index);
}

function isBackupSnapshot(snapshot: ModelSnapshot): boolean {
  return (
    Boolean(snapshot.failure) ||
    snapshot.id.startsWith("fallback-") ||
    snapshot.id.startsWith("mock-") ||
    snapshot.model === "deterministic-template"
  );
}

function buildApiCallTimings(live: FroglingsLiveState | null): ApiCallTiming[] {
  if (!live) return [];
  const evidenceProvider = live.sources.find((source) => source.retrievedVia !== "mock")?.retrievedVia;

  const evidenceCalls = evidenceProvider
    ? live.trace
        .filter((entry) => entry.step === "evidence" && typeof entry.durationMs === "number")
        .map((entry, index) => ({
          id: `${entry.id}-fact-search-${index}`,
          label: "fact search",
          detail: `${labelForEvidenceProvider(evidenceProvider)} evidence lookup`,
          durationMs: entry.durationMs ?? 0
        }))
    : [];

  const llmCalls = live.modelSnapshots
    .filter((snapshot) => typeof snapshot.latencyMs === "number" && isRealLlmSnapshot(snapshot))
    .map((snapshot) => {
      const attempts = snapshot.attempts ?? [];
      const shouldShowAttempts =
        attempts.length > 1 || attempts.some((attempt) => attempt.status === "failed");

      return {
        id: snapshot.id,
        label: labelForApiSnapshot(snapshot),
        detail: snapshot.role,
        durationMs: snapshot.latencyMs ?? 0,
        children: shouldShowAttempts
          ? attempts.map((attempt) => ({
              id: `${snapshot.id}-${attempt.mode}-${attempt.attempt}-${attempt.status}`,
              label: labelForAttemptMode(attempt.mode),
              detail: detailForAttempt(attempt),
              durationMs: attempt.durationMs,
              status: attempt.status
            }))
          : undefined
      };
    });

  return [...evidenceCalls, ...llmCalls].filter((call, index, calls) => {
    return calls.findIndex((candidate) => candidate.id === call.id) === index;
  });
}

function isRealLlmSnapshot(snapshot: ModelSnapshot): boolean {
  return !isBackupSnapshot(snapshot) && snapshot.provider !== "local";
}

function labelForEvidenceProvider(provider: EvidenceSource["retrievedVia"]): string {
  if (provider === "tavily" || provider === "brave") return "Web Search Model";
  return "Fact Search";
}

function labelForApiSnapshot(snapshot: ModelSnapshot): string {
  return labelForModelId(snapshot.model);
}

function labelForAttemptMode(mode: "json_schema" | "json_object"): string {
  return mode === "json_schema" ? "strict schema" : "live JSON retry";
}

function detailForAttempt(attempt: NonNullable<ModelSnapshot["attempts"]>[number]): string {
  if (attempt.status === "ok") {
    return attempt.mode === "json_object" ? "completed with live model" : "completed";
  }
  return `failed: ${friendlyAttemptError(attempt.message)}`;
}

function friendlyAttemptError(message: string | undefined): string {
  if (!message) return "provider error";
  if (message.toLowerCase() === "provider returned error") return "provider error";
  return message;
}

function labelForModelId(id: string): string {
  return id
    .split("/")
    .pop()!
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace(/\bGpt\b/g, "GPT");
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${Math.round(durationMs)} ms`;
  }
  return `${(durationMs / 1000).toFixed(durationMs < 10000 ? 1 : 0)} s`;
}

// -------------------------------------------------------------------------
// Tiny context so Bubble can trigger play/stop without prop-drilling.
// -------------------------------------------------------------------------

type FrogSoundsCtx = {
  ready: boolean;
  play: (side: "pro" | "con" | "judge", options?: { random?: boolean }) => void;
  stop: (side: "pro" | "con" | "judge") => void;
  beep: (options: { frequency: number; durationMs: number; delayMs?: number; gain?: number }) => void;
};

const noopSounds: FrogSoundsCtx = { ready: false, play: () => {}, stop: () => {}, beep: () => {} };
const FrogSoundsContext = createContext<FrogSoundsCtx>(noopSounds);

// -------------------------------------------------------------------------
// Top-level workspace
// -------------------------------------------------------------------------

export function FroglingsWorkspace() {
  const [subject, setSubject] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [live, dispatch] = useReducer(liveReducer, null);
  const [, setDebate] = useState<DebateRecord | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [controlPanelOpen, setControlPanelOpen] = useState(false);
  const [modelOptions, setModelOptions] = useState<ModelOptionsResponse | null>(null);
  const [modelSelections, setModelSelections] = useState<ModelSelections | null>(null);
  const [modelOptionsError, setModelOptionsError] = useState<string | null>(null);
  const [userPreferences, setUserPreferences] = useState<UserPreferences>(defaultUserPreferences);
  const eventSourceRef = useRef<EventSource | null>(null);
  const sounds = useFrogSounds();
  const soundControls = useMemo(
    () => ({ ready: sounds.ready, play: sounds.play, stop: sounds.stop, beep: sounds.beep }),
    [sounds.ready, sounds.play, sounds.stop, sounds.beep]
  );
  // Show the intro on first session only. We default to false on the
  // server (so the overlay never SSRs and flashes), then flip to true
  // after mount if localStorage says we haven't shown it yet.
  const [showIntro, setShowIntro] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const seen = window.localStorage.getItem(INTRO_SEEN_KEY);
      if (seen !== "1") setShowIntro(true);
    } catch {
      // localStorage may be unavailable; just skip the overlay.
    }
  }, []);

  useEffect(() => {
    setUserPreferences(readStoredUserPreferences());
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadModelOptions() {
      try {
        const response = await fetchWithRetry("/api/model-options", { cache: "no-store" });
        const payload = (await response.json()) as ModelOptionsResponse;
        if (cancelled) return;

        const sanitized = sanitizeModelSelections(payload, readStoredModelSelections());
        setModelOptions(payload);
        setModelSelections(sanitized);
        setModelOptionsError(null);
      } catch {
        if (cancelled) return;
        setModelOptionsError("Model choices are unavailable right now.");
      }
    }

    void loadModelOptions();

    return () => {
      cancelled = true;
    };
  }, []);

  const dismissIntro = () => {
    setShowIntro(false);
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(INTRO_SEEN_KEY, "1");
      }
    } catch {
      // ignore
    }
  };

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
    // The form submit is the user's first explicit interaction — that's
    // our chance to unlock the AudioContext under browser autoplay rules.
    void sounds.unlock();

    try {
      const response = await fetchWithRetry("/api/debates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject,
          mode: "hybrid_council",
          evidence: "cited",
          models: modelSelections ?? undefined,
          devOptions:
            userPreferences.liveApisInDev &&
            modelOptions?.dev?.liveApiToggleAvailable &&
            modelOptions.dev.hasOpenRouterKey &&
            modelOptions.dev.hasTavilyKey
              ? { liveApis: true }
              : undefined,
          // The whole point of the funner version: ask the engine for
          // the simpler 1-on-1 shape.
          councilSize: "duo"
        })
      });
      const payload = (await response.json()) as { debate?: DebateRecord; error?: string };
      if (!response.ok || !payload.debate) {
        throw new Error(payload.error ?? DEBATE_UNAVAILABLE_MESSAGE);
      }

      const seed = payload.debate;
      dispatch({ type: "init", debateId: seed.id, subject: seed.subject });

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
          const finalRes = await fetchWithRetry(`/api/debates/${seed.id}`, { cache: "no-store" });
          const finalPayload = (await finalRes.json()) as { debate?: DebateRecord };
          if (finalPayload.debate) {
            setDebate(finalPayload.debate);
            dispatch({ type: "hydrate", debate: finalPayload.debate });
          }
        } catch {
          // ignore
        }
      };
      es.addEventListener("complete", () => void finalize());
      es.addEventListener("error", (streamEvent) => {
        if (streamEvent instanceof MessageEvent) {
          void finalize();
        }
      });
      es.addEventListener("closed", () => {
        es.close();
        eventSourceRef.current = null;
      });
    } catch (caughtError) {
      setSubmitError(
        caughtError instanceof Error ? caughtError.message : DEBATE_UNAVAILABLE_MESSAGE
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  function startOver() {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setDebate(null);
    dispatch({ type: "reset" });
    setSubmitError(null);
  }

  return (
    <main className="mx-auto w-full max-w-[960px] px-4 py-6 sm:py-10">
      <header className="flex items-center justify-between">
        <Link href={"/" as Route} className="flex items-center gap-3 text-pond">
          <FunFrog mood="idle" size={42} bob={false} />
          <span className="text-lg font-black tracking-tight">DebateFrog</span>
          {isPreviewDeploy ? (
            <span className="rounded-full border border-leaf/30 bg-mint/70 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-pond">
              Preview
            </span>
          ) : null}
        </Link>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={sounds.toggleMute}
            aria-pressed={sounds.muted}
            aria-label={sounds.muted ? "Unmute frog sounds" : "Mute frog sounds"}
            title={sounds.muted ? "Unmute frog sounds" : "Mute frog sounds"}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/70 text-pond shadow-sm transition hover:bg-white"
          >
            {sounds.muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </button>
          {live ? (
            <button
              type="button"
              onClick={startOver}
              className="inline-flex items-center gap-1.5 rounded-full bg-white/70 px-3 py-1.5 text-xs font-bold text-pond shadow-sm transition hover:bg-white"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              New question
            </button>
          ) : null}
        </div>
      </header>

      {!live ? (
        <FroglingsHero
          subject={subject}
          onSubjectChange={setSubject}
          isSubmitting={isSubmitting}
          error={submitError}
          onSubmit={runDebate}
        />
      ) : (
        <FrogSoundsContext.Provider value={soundControls}>
          <FroglingsLive live={live} preferences={userPreferences} />
        </FrogSoundsContext.Provider>
      )}

      {/*
        Tucked-away footer. The "Show intro again" link lets a kid or
        parent re-open the explainer. The audio attribution link
        satisfies the CC BY 4.0 requirement that credit travel with
        the deployed work — see public/sounds/CREDITS.md.
      */}
      <footer className="mt-10 flex flex-col items-center gap-2">
        <button
          type="button"
          onClick={() => setShowIntro(true)}
          className="text-[11px] font-semibold text-pond/55 underline-offset-2 transition hover:text-pond hover:underline"
        >
          Show intro again
        </button>
        <button
          type="button"
          onClick={() => setFeedbackOpen(true)}
          className="text-[11px] font-semibold text-pond/55 underline-offset-2 transition hover:text-pond hover:underline"
        >
          Send feedback
        </button>
        <p className="text-[10px] text-pond/45">
          Some frog sounds:{" "}
          <a
            href="https://freesound.org/people/daveincamas/sounds/32834/"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 transition hover:text-pond"
          >
            daveincamas
          </a>{" "}
          on Freesound, used under{" "}
          <a
            href="https://creativecommons.org/licenses/by/4.0/"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 transition hover:text-pond"
          >
            CC BY 4.0
          </a>
          {" "}(trimmed).
        </p>
      </footer>

      {showIntro ? <FroglingsIntro onDismiss={dismissIntro} /> : null}
      <FeedbackModal
        debateId={live?.debateId}
        open={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
      />
      <FroglingsControlPanel
        open={controlPanelOpen}
        apiCalls={buildApiCallTimings(live)}
        modelOptions={modelOptions}
        modelOptionsError={modelOptionsError}
        selections={modelSelections}
        preferences={userPreferences}
        onToggle={() => setControlPanelOpen((value) => !value)}
        onClose={() => setControlPanelOpen(false)}
        onSelectionsChange={(next) => {
          setModelSelections(next);
          storeModelSelections(next);
        }}
        onReset={() => {
          if (!modelOptions) return;
          setModelSelections(modelOptions.defaults);
          storeModelSelections(modelOptions.defaults);
        }}
        onPreferencesChange={(next) => {
          setUserPreferences(next);
          storeUserPreferences(next);
        }}
      />
    </main>
  );
}

function FeedbackModal({
  debateId,
  open,
  onClose
}: {
  debateId?: string;
  open: boolean;
  onClose: () => void;
}) {
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");

  useEffect(() => {
    if (!open) return;
    setStatus("idle");
  }, [open]);

  if (!open) return null;

  async function submitFeedback() {
    if (message.trim().length === 0 || status === "submitting") return;
    setStatus("submitting");

    try {
      const response = await fetchWithRetry("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          debateId,
          pagePath: typeof window === "undefined" ? undefined : window.location.pathname
        })
      });

      if (!response.ok) {
        throw new Error("Unable to save feedback.");
      }

      setStatus("success");
      setMessage("");
    } catch {
      setStatus("error");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-pond/35 px-4 backdrop-blur-sm">
      <section className="w-full max-w-[460px] rounded-2xl border border-mud/20 bg-panel p-5 shadow-lily">
        {status === "success" ? (
          <div className="text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-mint/70 text-pond">
              <CheckCircle2 className="h-6 w-6" />
            </div>
            <h2 className="mt-4 text-lg font-black text-pond">Thank you for your feedback.</h2>
            <button
              type="button"
              onClick={onClose}
              className="mt-5 rounded-xl bg-pond px-5 py-2.5 text-sm font-black text-white transition hover:bg-leafDark"
            >
              Close
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-black text-pond">Send feedback</h2>
                <p className="mt-1 text-sm leading-relaxed text-ink/65">
                  Tell us what worked, what felt odd, or what the frogs should do better.
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close feedback"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/70 text-pond transition hover:bg-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              maxLength={2000}
              className="mt-4 min-h-[140px] w-full resize-y rounded-xl border border-mud/20 bg-white/90 px-3.5 py-3 text-sm leading-relaxed text-ink outline-none transition focus:border-leaf"
              placeholder="Type your feedback..."
            />

            {status === "error" ? (
              <div className="mt-3 rounded-xl border border-berry/40 bg-berry/10 px-3 py-2 text-sm text-berry">
                Feedback could not be saved right now.
              </div>
            ) : null}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl bg-white/80 px-4 py-2 text-sm font-bold text-pond transition hover:bg-white"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitFeedback()}
                disabled={message.trim().length === 0 || status === "submitting"}
                className="inline-flex items-center gap-2 rounded-xl bg-pond px-4 py-2 text-sm font-black text-white transition hover:bg-leafDark disabled:cursor-not-allowed disabled:bg-mud/35"
              >
                {status === "submitting" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Submit
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function FroglingsControlPanel({
  open,
  apiCalls,
  modelOptions,
  modelOptionsError,
  selections,
  preferences,
  onToggle,
  onClose,
  onSelectionsChange,
  onReset,
  onPreferencesChange
}: {
  open: boolean;
  apiCalls: ApiCallTiming[];
  modelOptions: ModelOptionsResponse | null;
  modelOptionsError: string | null;
  selections: ModelSelections | null;
  preferences: UserPreferences;
  onToggle: () => void;
  onClose: () => void;
  onSelectionsChange: (next: ModelSelections) => void;
  onReset: () => void;
  onPreferencesChange: (next: UserPreferences) => void;
}) {
  const [apiCallsOpen, setApiCallsOpen] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const controlButtonRef = useRef<HTMLButtonElement>(null);
  const roles: Array<{ key: ModelRole; label: string }> = [
    { key: "yes", label: "YES frog" },
    { key: "no", label: "NO frog" },
    { key: "judge", label: "Judge frog" }
  ];
  const maxDurationMs = Math.max(...apiCalls.map((call) => call.durationMs), 1);
  const devLiveApisAvailable = Boolean(modelOptions?.dev?.liveApiToggleAvailable);
  const devLiveApisReady = Boolean(modelOptions?.dev?.hasOpenRouterKey && modelOptions?.dev?.hasTavilyKey);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target)) return;
      if (controlButtonRef.current?.contains(target)) return;
      onClose();
    };

    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target)) return;
      if (controlButtonRef.current?.contains(target)) return;
      onClose();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("click", handleClick);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("click", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, open]);

  return (
    <>
      {open ? (
        <div
          aria-hidden="true"
          className="fixed inset-0 z-30 cursor-default bg-transparent"
          onClick={onClose}
          onPointerDown={onClose}
        />
      ) : null}
      <div className="pointer-events-none fixed bottom-4 right-4 z-40 flex flex-col items-end gap-3">
      {open ? (
        <section
          ref={panelRef}
          className="pointer-events-auto h-[min(calc(100vh-2rem),760px)] w-[min(calc(100vw-2rem),460px)] overflow-y-auto [scrollbar-gutter:stable] rounded-2xl border border-pond/15 bg-[#111a16]/95 p-4 text-white shadow-2xl backdrop-blur"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-mint" />
              <h2 className="text-sm font-black">Debate controls</h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close controls"
              className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-white/10 text-white/80 transition hover:bg-white/20"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.06] p-3">
            <div className="text-[11px] font-black uppercase tracking-wide text-mint">Features</div>
            <label className="mt-3 flex items-center justify-between gap-4 rounded-lg bg-white/[0.05] px-3 py-2">
              <span>
                <span className="block text-xs font-bold text-white/85">Opening splash</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-white/55">
                  Show the animated 3...2...1 screen before each debate.
                </span>
              </span>
              <input
                type="checkbox"
                checked={preferences.openingSplash}
                onChange={(event) => {
                  onPreferencesChange({ ...preferences, openingSplash: event.target.checked });
                }}
                className="h-5 w-5 accent-mint"
              />
            </label>
            {devLiveApisAvailable ? (
              <label className="mt-3 flex items-center justify-between gap-4 rounded-lg bg-white/[0.05] px-3 py-2">
                <span>
                  <span className="block text-xs font-bold text-white/85">Use live APIs in dev</span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-white/55">
                    Run local debates through real AI Model and Web Search Model calls.
                  </span>
                  {!devLiveApisReady ? (
                    <span className="mt-1 block text-[10px] font-bold text-berry">
                      Add local AI Model and Web Search Model keys to enable this.
                    </span>
                  ) : null}
                </span>
                <input
                  type="checkbox"
                  checked={preferences.liveApisInDev && devLiveApisReady}
                  disabled={!devLiveApisReady}
                  onChange={(event) => {
                    onPreferencesChange({ ...preferences, liveApisInDev: event.target.checked });
                  }}
                  className="h-5 w-5 accent-mint disabled:opacity-40"
                />
              </label>
            ) : null}
          </div>

          <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.06] p-3">
            <div className="text-[11px] font-black uppercase tracking-wide text-mint">Model choices</div>
            <p className="mt-1 text-xs leading-relaxed text-white/65">
              Pick which curated model speaks for each frog.
            </p>

            {modelOptionsError ? (
              <div className="mt-3 rounded-lg border border-berry/50 bg-berry/20 px-3 py-2 text-xs text-white">
                {modelOptionsError}
              </div>
            ) : null}

            {modelOptions && selections ? (
              <div className="mt-3 space-y-3">
                {roles.map((role) => (
                  <label key={role.key} className="block">
                    <span className="text-xs font-bold text-white/75">{role.label}</span>
                    <select
                      value={selections[role.key]}
                      onChange={(event) => {
                        onSelectionsChange({ ...selections, [role.key]: event.target.value });
                      }}
                      className="mt-1 h-10 w-full rounded-lg border border-white/10 bg-[#1c2a23] px-3 text-xs font-semibold text-white outline-none transition focus:border-mint"
                    >
                      {modelOptions.options.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}

                <button
                  type="button"
                  onClick={onReset}
                  className="w-full rounded-lg bg-white/10 px-3 py-2 text-xs font-black text-white/80 transition hover:bg-white/15"
                >
                  Reset to defaults
                </button>
              </div>
            ) : (
              <div className="mt-3 flex items-center gap-2 text-xs text-white/70">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading model choices
              </div>
            )}
          </div>

          <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.06] p-3">
            <button
              type="button"
              onClick={() => setApiCallsOpen((value) => !value)}
              className="flex w-full items-center justify-between gap-3 text-left"
              aria-expanded={apiCallsOpen}
            >
              <span className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-mint" />
                <span className="text-[11px] font-black uppercase tracking-wide text-mint">
                  API calls
                </span>
              </span>
              <ChevronDown
                className={`h-4 w-4 text-white/60 transition ${apiCallsOpen ? "rotate-180" : ""}`}
              />
            </button>

            {apiCallsOpen ? (
              <div className="mt-3 space-y-2">
                {apiCalls.length > 0 ? (
                  apiCalls.map((call) => {
                    const widthPercent = Math.max(8, Math.round((call.durationMs / maxDurationMs) * 100));
                    return (
                      <div key={call.id} className="rounded-lg bg-white/[0.045] px-3 py-2">
                        <ApiCallBar call={call} widthPercent={widthPercent} />
                        {call.children?.length ? (
                          <div className="mt-2 space-y-1.5 border-l border-white/10 pl-3">
                            {call.children.map((child) => {
                              const childWidthPercent = Math.max(
                                8,
                                Math.round((child.durationMs / Math.max(call.durationMs, 1)) * 100)
                              );
                              return (
                                <ApiCallBar
                                  key={child.id}
                                  call={child}
                                  widthPercent={childWidthPercent}
                                  compact
                                />
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                ) : (
                  <div className="rounded-lg bg-white/[0.045] px-3 py-2 text-xs text-white/55">
                    Start a debate to see call timings.
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      <button
        ref={controlButtonRef}
        type="button"
        onClick={onToggle}
        aria-label="Open Debatefrog controls"
        aria-expanded={open}
        className="pointer-events-auto inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-white/20 bg-[#111a16] text-mint shadow-2xl transition hover:scale-105 hover:bg-[#17251d]"
      >
        <Settings className="h-5 w-5" />
      </button>
      </div>
    </>
  );
}

function ApiCallBar({
  call,
  widthPercent,
  compact = false
}: {
  call: ApiCallTiming;
  widthPercent: number;
  compact?: boolean;
}) {
  return (
    <div
      className={`grid items-center gap-3 ${
        compact ? "grid-cols-[minmax(110px,40%)_1fr]" : "grid-cols-[minmax(120px,42%)_1fr]"
      }`}
    >
      <div className="min-w-0">
        <div className={`truncate font-black text-white/85 ${compact ? "text-[10px]" : "text-[11px]"}`}>
          {call.label}
        </div>
        <div className="truncate text-[10px] text-white/45">{call.detail}</div>
      </div>
      <div className="min-w-0">
        <div className={`${compact ? "h-4" : "h-5"} rounded-full bg-[#0c140f] p-1`}>
          <div
            className={`h-full rounded-full ${call.status === "failed" ? "bg-berry" : "bg-mint"}`}
            style={{ width: `${widthPercent}%` }}
          />
        </div>
        <div className="mt-1 text-right text-[10px] font-bold text-white/55">
          {formatDuration(call.durationMs)}
        </div>
      </div>
    </div>
  );
}

function readStoredModelSelections(): Partial<ModelSelections> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(MODEL_SETTINGS_KEY);
    return raw ? (JSON.parse(raw) as Partial<ModelSelections>) : {};
  } catch {
    return {};
  }
}

function storeModelSelections(selections: ModelSelections) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MODEL_SETTINGS_KEY, JSON.stringify(selections));
  } catch {
    // ignore storage failures
  }
}

function sanitizeModelSelections(
  modelOptions: ModelOptionsResponse,
  stored: Partial<ModelSelections>
): ModelSelections {
  const ids = new Set(modelOptions.options.map((option) => option.id));
  return {
    yes: stored.yes && ids.has(stored.yes) ? stored.yes : modelOptions.defaults.yes,
    no: stored.no && ids.has(stored.no) ? stored.no : modelOptions.defaults.no,
    judge: stored.judge && ids.has(stored.judge) ? stored.judge : modelOptions.defaults.judge
  };
}

function readStoredUserPreferences(): UserPreferences {
  if (typeof window === "undefined") return defaultUserPreferences;
  try {
    const raw = window.localStorage.getItem(USER_PREFERENCES_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<UserPreferences>) : {};
    return {
      openingSplash:
        typeof parsed.openingSplash === "boolean"
          ? parsed.openingSplash
          : defaultUserPreferences.openingSplash,
      liveApisInDev:
        typeof parsed.liveApisInDev === "boolean"
          ? parsed.liveApisInDev
          : defaultUserPreferences.liveApisInDev
    };
  } catch {
    return defaultUserPreferences;
  }
}

function storeUserPreferences(preferences: UserPreferences) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(USER_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // ignore storage failures
  }
}

// -------------------------------------------------------------------------
// Question entry
// -------------------------------------------------------------------------

function FroglingsHero({
  subject,
  onSubjectChange,
  isSubmitting,
  error,
  onSubmit
}: {
  subject: string;
  onSubjectChange: (value: string) => void;
  isSubmitting: boolean;
  error: string | null;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const [isQuestionFocused, setIsQuestionFocused] = useState(false);
  const exampleQuestion = kidPrompts[0];

  return (
    <section className="mt-6 grid gap-8 lg:mt-10 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
      <div className="flex flex-col justify-center">
        <h1
          className="font-black leading-[1.12] text-pond"
          style={{ fontSize: "clamp(2.4rem, 6vw, 4rem)" }}
        >
          Two sides.
          <br />
          One judge.
          <br />
          One big question.
        </h1>
        <p className="mt-4 max-w-[480px] text-base leading-relaxed text-ink/80">
          One YES frog and one NO frog will debate your question. The judge frog picks the winner.
          You get to watch the whole thing!
        </p>
        <div className="mt-5 flex items-center gap-3">
          <div className="flex flex-col items-center">
            <FunFrog mood="pro" size={64} />
            <span className="mt-1 text-[11px] font-black uppercase tracking-wide text-pond">
              YES frog
            </span>
          </div>
          <span className="text-sm font-black text-mud/60">vs.</span>
          <div className="flex flex-col items-center">
            <FunFrog mood="con" size={64} />
            <span className="mt-1 text-[11px] font-black uppercase tracking-wide text-berry">
              NO frog
            </span>
          </div>
          <span className="text-sm font-black text-mud/60">+</span>
          <div className="flex flex-col items-center">
            <FunFrog mood="judge" size={64} />
            <span className="mt-1 text-[11px] font-black uppercase tracking-wide text-[#5c4583]">
              Judge frog
            </span>
          </div>
        </div>
      </div>

      <form
        onSubmit={onSubmit}
        className="rounded-2xl border border-mud/20 bg-panel/90 p-5 shadow-lily backdrop-blur"
      >
        <label htmlFor="subject" className="text-sm font-extrabold text-mud">
          What should the frogs argue about?
        </label>
        <textarea
          id="subject"
          value={subject}
          onChange={(event) => onSubjectChange(event.target.value)}
          onFocus={() => setIsQuestionFocused(true)}
          onBlur={() => setIsQuestionFocused(false)}
          placeholder={isQuestionFocused ? "" : exampleQuestion}
          className="mt-1.5 min-h-[100px] w-full resize-y rounded-xl border border-mud/20 bg-white/90 px-3.5 py-3 text-base leading-relaxed text-ink outline-none transition focus:border-leaf"
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
          Start the debate!
        </button>

        <div className="mt-5">
          <div className="mb-2 text-[11px] font-extrabold uppercase tracking-wide text-mud/70">
            Or pick a question
          </div>
          <div className="flex flex-wrap gap-2">
            {kidPrompts.map((prompt) => (
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
      </form>
    </section>
  );
}

// -------------------------------------------------------------------------
// Live view — kid-friendly stage banner, named frogs, round bubbles, verdict
// -------------------------------------------------------------------------

function FroglingsLive({
  live,
  preferences
}: {
  live: FroglingsLiveState;
  preferences: UserPreferences;
}) {
  const staged = useStagedFroglingsTurns(live);
  const countdownStarted = isStartCountdownStarted(live);
  const showStartSequence = useStartSequenceVisibility(
    live,
    staged,
    preferences.openingSplash,
    countdownStarted
  );

  return (
    <div className="mt-6 space-y-5">
      <QuestionBanner live={live} staged={staged} showStartSequence={showStartSequence} />
      {live.status === "failed" ? (
        <div className="rounded-xl border border-berry/40 bg-berry/10 px-4 py-3 text-sm text-berry">
          {live.errorMessage ?? DEBATE_UNAVAILABLE_MESSAGE}
        </div>
      ) : null}
      {(live.backupReasons ?? []).length > 0 ? <BackupAnswersNotice /> : null}
      {showStartSequence ? (
        <DebateStartSequence live={live} countdownStarted={countdownStarted} />
      ) : null}
      {live.teams && !preferences.openingSplash ? <FrogIntros teams={live.teams} /> : null}
      {!showStartSequence ? (
        <>
          <CurrentRoundCallout
            live={live}
            readyForVerdict={staged.readyForVerdict}
            visibleTurns={staged.visibleTurns}
          />
          <Rounds live={live} visibleTurns={staged.visibleTurns} onTurnComplete={staged.showNextTurn} />
          <Verdict live={live} readyForVerdict={staged.readyForVerdict} />
        </>
      ) : null}
    </div>
  );
}

function useStartSequenceVisibility(
  live: FroglingsLiveState,
  staged: ReturnType<typeof useStagedFroglingsTurns>,
  enabled: boolean,
  countdownStarted: boolean
) {
  const [countdownWindowDone, setCountdownWindowDone] = useState(false);

  useEffect(() => {
    setCountdownWindowDone(false);
  }, [live.debateId]);

  useEffect(() => {
    if (!countdownStarted) return;
    setCountdownWindowDone(false);
    const timer = window.setTimeout(() => {
      setCountdownWindowDone(true);
    }, START_SEQUENCE_MIN_MS);

    return () => window.clearTimeout(timer);
  }, [countdownStarted, live.debateId]);

  if (!enabled || live.status === "failed" || live.status === "partial") {
    return false;
  }

  if (!countdownWindowDone) return true;

  if (live.done || live.status === "complete" || live.status === "judging") {
    return false;
  }

  return !staged.hasTurns;
}

function isStartCountdownStarted(live: FroglingsLiveState) {
  return live.status === "debating" || live.turns.length > 0 || live.done;
}

function useStagedFroglingsTurns(live: FroglingsLiveState) {
  const debateTurns = useMemo(() => orderedFroglingsTurns(live.turns), [live.turns]);
  const [visibleCount, setVisibleCount] = useState(0);

  useEffect(() => {
    setVisibleCount(debateTurns.length > 0 ? 1 : 0);
  }, [live.debateId]);

  useEffect(() => {
    setVisibleCount((count) => {
      if (debateTurns.length === 0) return 0;
      if (count <= 0) return 1;
      return count;
    });
  }, [debateTurns.length]);

  const showNextTurn = useCallback(() => {
    window.setTimeout(() => {
      setVisibleCount((count) => count + 1);
    }, 450);
  }, []);

  const visibleTurns = debateTurns.slice(0, visibleCount);
  const readyForVerdict =
    debateTurns.length === 0
      ? live.status === "judging" || live.status === "complete" || live.done
      : visibleCount > debateTurns.length;
  const isReplayingTurns = debateTurns.length > 0 && visibleCount < debateTurns.length;
  const isFinishingLastTurn = debateTurns.length > 0 && visibleCount === debateTurns.length;

  return {
    visibleTurns,
    readyForVerdict,
    showNextTurn,
    hasTurns: debateTurns.length > 0,
    isReplayingTurns,
    isFinishingLastTurn
  };
}

async function fetchWithRetry(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= CLIENT_API_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(input, init);
      if (!isRetriableClientResponse(response) || attempt >= CLIENT_API_MAX_ATTEMPTS) {
        return response;
      }
      lastError = new Error(`Request failed with ${response.status}.`);
    } catch (error) {
      lastError = error;
      if (attempt >= CLIENT_API_MAX_ATTEMPTS) {
        break;
      }
    }

    await delay(CLIENT_API_RETRY_BASE_DELAY_MS * attempt);
  }

  throw lastError instanceof Error ? lastError : new Error(DEBATE_UNAVAILABLE_MESSAGE);
}

function isRetriableClientResponse(response: Response): boolean {
  return response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function QuestionBanner({
  live,
  staged,
  showStartSequence
}: {
  live: FroglingsLiveState;
  staged: ReturnType<typeof useStagedFroglingsTurns>;
  showStartSequence: boolean;
}) {
  const isActuallyDone = (live.status === "complete" || live.done) && staged.readyForVerdict;
  const stageCopy = froglingsStageCopy(live, staged);

  return (
    <section className="rounded-2xl border border-mud/20 bg-panel/90 p-5 shadow-lily">
      <div className="text-[11px] font-extrabold uppercase tracking-wide text-mud/60">
        Question
      </div>
      <div className="mt-1 text-lg leading-snug text-ink">
        {literalQuestionText(live.subject)}
      </div>
      {!showStartSequence ? (
        <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-cream/70 px-3 py-1 text-xs font-bold text-mud">
          {isActuallyDone ? null : (
            <Loader2 className="h-3 w-3 animate-spin text-leaf" />
          )}
          {stageCopy}
        </div>
      ) : null}
    </section>
  );
}

function froglingsStageCopy(
  live: FroglingsLiveState,
  staged: ReturnType<typeof useStagedFroglingsTurns>
) {
  if (staged.hasTurns && !staged.readyForVerdict) {
    if (staged.isReplayingTurns) return "the frogs are taking turns";
    if (staged.isFinishingLastTurn) return "the last frog is finishing up";
  }

  if (live.status === "debating" && !staged.hasTurns) {
    return "the frogs are getting their arguments ready";
  }

  if (live.status === "complete" && (live.backupReasons ?? []).length > 0) {
    return "finished with backup answers";
  }

  return friendlyStage[live.status];
}

function BackupAnswersNotice() {
  return (
    <section className="flex items-start gap-3 rounded-2xl border border-mud/20 bg-cream/80 p-4 text-sm text-mud shadow-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-berry" aria-hidden="true" />
      <div>
        <div className="font-black text-pond">Backup answers are showing.</div>
        <p className="mt-1 leading-relaxed text-ink/70">
          The live model or search setup did not answer in this dev run, so Debatefrog used local
          backup notes. The debate can still play through, but these answers are less specific.
        </p>
      </div>
    </section>
  );
}

function froglingsStartSequenceStatusCopy(live: FroglingsLiveState) {
  if (live.status === "researching" || live.teams) {
    return "the frogs are taking their places";
  }

  if (live.status === "debating" || live.turns.length > 0 || live.done) {
    return "opening croak in 3... 2... 1...";
  }

  return "the lily pad stage is lighting up";
}

const startSequenceSteps = [
  "Light the lily pad",
  "Seat the frogs",
  "Open the debate"
] as const;

function DebateStartSequence({
  live,
  countdownStarted
}: {
  live: FroglingsLiveState;
  countdownStarted: boolean;
}) {
  const sounds = useContext(FrogSoundsContext);
  const hasPlayedCueRef = useRef(false);
  const sequenceRef = useRef<HTMLElement>(null);
  const [countdownTitleActive, setCountdownTitleActive] = useState(false);
  const activeStep = startSequenceStepIndex(live);
  const copy = startSequenceCopy(live, countdownTitleActive);

  useEffect(() => {
    scrollActiveFrogIntoView(sequenceRef.current);
  }, []);

  useEffect(() => {
    hasPlayedCueRef.current = false;
  }, [live.debateId]);

  useEffect(() => {
    if (!countdownStarted) {
      setCountdownTitleActive(false);
      return;
    }
    setCountdownTitleActive(false);
    const timer = window.setTimeout(() => {
      setCountdownTitleActive(true);
    }, START_COUNTDOWN_TITLE_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [countdownStarted, live.debateId]);

  useEffect(() => {
    if (!countdownStarted || hasPlayedCueRef.current || !sounds.ready) return;
    hasPlayedCueRef.current = true;

    const timers = START_COUNTDOWN_CUES.map((cue) =>
      window.setTimeout(() => {
        sounds.beep({
          frequency: cue.frequency,
          durationMs: cue.durationMs,
          gain: cue.gain
        });
      }, cue.delayMs)
    );

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [countdownStarted, sounds]);

  return (
    <section
      ref={sequenceRef}
      className="start-sequence hop-in overflow-hidden rounded-2xl border border-pond/15 bg-panel/95 p-5 shadow-lily"
      aria-live="polite"
    >
      <div className="grid gap-5 md:grid-cols-[minmax(260px,0.9fr)_minmax(0,1fr)] md:items-center">
        <div className="start-stage" aria-hidden="true">
          <div className="start-stage-light" />
          <div className="start-water-line start-water-line-one" />
          <div className="start-water-line start-water-line-two" />
          <div className="start-water-line start-water-line-three" />
          <div className="start-lily-pad">
            <span className="start-lily-mark start-lily-mark-left" />
            <span className="start-lily-mark start-lily-mark-right" />
          </div>
          <div className="start-countdown">
            {countdownStarted ? (
              <>
                <span>3</span>
                <span>2</span>
                <span>1</span>
              </>
            ) : null}
          </div>
          <div className="start-frog start-frog-pro">
            <FunFrog mood="pro" size={64} />
          </div>
          <div className="start-frog start-frog-con">
            <FunFrog mood="con" size={64} />
          </div>
          <div className="start-frog start-frog-judge">
            <FunFrog mood="judge" size={58} bob={false} />
          </div>
        </div>

        <div className="min-w-0">
          <div className="inline-flex items-center gap-2 rounded-full bg-mint/70 px-3 py-1 text-[11px] font-black uppercase tracking-wide text-pond">
            <span className="h-2 w-2 rounded-full bg-leaf" />
            Debate starting
          </div>
          <h2 className="mt-3 text-2xl font-black leading-tight text-pond">{copy.title}</h2>
          <p className="mt-2 max-w-[520px] text-sm leading-relaxed text-ink/75">{copy.body}</p>
          <ol className="mt-4 grid gap-2 sm:grid-cols-3" aria-label="Start sequence progress">
            {startSequenceSteps.map((step, index) => (
              <li
                key={step}
                className={`start-sequence-step ${index <= activeStep ? "is-active" : ""}`}
              >
                <span className="start-sequence-step-dot" aria-hidden="true" />
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

function startSequenceStepIndex(live: FroglingsLiveState) {
  if (live.status === "debating" || live.turns.length > 0 || live.done) return 2;
  if (live.status === "researching" || live.teams) return 1;
  return 0;
}

function startSequenceCopy(live: FroglingsLiveState, countdownTitleActive: boolean) {
  if (countdownTitleActive) {
    return {
      title: "Opening croak in 3... 2... 1...",
      body: "The frogs have their notes and the judge is watching. The first round is about to hop in."
    };
  }

  if (live.status === "researching") {
    return {
      title: "The frogs are collecting facts.",
      body: "YES frog and NO frog are taking their places while the judge checks the question."
    };
  }

  return {
    title: "The lily pad stage is lighting up.",
    body: "The debate is warming up, the question is getting framed, and the frogs are almost ready."
  };
}

function FrogIntros({ teams }: { teams: DebateTeam }) {
  const pro = teams.pro[0];
  const con = teams.con[0];
  const sounds = useContext(FrogSoundsContext);
  const hasPlayedIntroRef = useRef(false);

  useEffect(() => {
    if (hasPlayedIntroRef.current || !sounds.ready || !pro || !con) return;
    hasPlayedIntroRef.current = true;

    sounds.play("pro");
    const timers = [
      window.setTimeout(() => sounds.stop("pro"), 340),
      window.setTimeout(() => sounds.play("con"), 460),
      window.setTimeout(() => sounds.stop("con"), 820)
    ];

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      sounds.stop("pro");
      sounds.stop("con");
    };
  }, [pro, con, sounds]);

  return (
    <section className="grid gap-3 md:grid-cols-2">
      <div className="flex items-center gap-3 rounded-2xl border border-leaf/30 bg-mint/40 p-3">
        <FunFrog mood="pro" size={56} hop />
        <div className="min-w-0">
          <div className="text-[11px] font-black uppercase tracking-wide text-pond">YES frog</div>
          <div className="mt-0.5 text-sm font-bold text-ink truncate">
            {pro ? froglingsFrogName("pro") : "—"}
          </div>
          <div className="text-xs text-ink/60">Argues the YES side</div>
        </div>
      </div>
      <div className="flex items-center gap-3 rounded-2xl border border-berry/30 bg-lily/40 p-3">
        <FunFrog mood="con" size={56} hop />
        <div className="min-w-0">
          <div className="text-[11px] font-black uppercase tracking-wide text-berry">NO frog</div>
          <div className="mt-0.5 text-sm font-bold text-ink truncate">
            {con ? froglingsFrogName("con") : "—"}
          </div>
          <div className="text-xs text-ink/60">Argues the NO side</div>
        </div>
      </div>
    </section>
  );
}

/**
 * Announces the currently-arriving round in plain language. Uses the
 * latest debate-round turn in live.turns as the "now playing" signal,
 * and re-keys on round change so the hop-in animation replays each
 * time. Hidden once judging/complete take over.
 */
function CurrentRoundCallout({
  live,
  readyForVerdict,
  visibleTurns
}: {
  live: FroglingsLiveState;
  readyForVerdict: boolean;
  visibleTurns: RoundTurn[];
}) {
  // Treat only the four kid-facing debate rounds as "now playing"
  // candidates; judge_review/synthesis are handled by Verdict.
  const trackedRounds: DebateRound[] = [
    "opening",
    "cross_examination",
    "rebuttal",
    "closing"
  ];

  const latestDebateRound = [...visibleTurns]
    .reverse()
    .find((turn) => trackedRounds.includes(turn.round))?.round;

  if (!latestDebateRound) return null;
  if (readyForVerdict && (live.status === "judging" || live.status === "complete")) return null;

  const meta = friendlyRound[latestDebateRound];
  const index = trackedRounds.indexOf(latestDebateRound);
  const ordinal = index >= 0 ? index + 1 : 1;

  return (
    <section
      // Re-key on round so the hop-in animation runs each time a new
      // round arrives — kids see a clear "we just changed gears" signal.
      key={latestDebateRound}
      className="hop-in flex items-center gap-3 rounded-2xl border border-leaf/40 bg-gradient-to-br from-mint/70 to-cream/40 p-4 shadow-sm"
    >
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-pond text-base font-black text-white shadow-lily">
        {ordinal}
      </div>
      <div className="min-w-0">
        <div className="text-[11px] font-extrabold uppercase tracking-wide text-pond/70">
          Now arriving — Round {ordinal} of 4
        </div>
        <div className="mt-0.5 text-base font-black text-pond">{meta.title.replace(/^Round \d+ — /, "")}</div>
        <div className="mt-0.5 text-xs text-ink/70">{meta.blurb}</div>
      </div>
    </section>
  );
}

function Rounds({
  live,
  visibleTurns,
  onTurnComplete
}: {
  live: FroglingsLiveState;
  visibleTurns: RoundTurn[];
  onTurnComplete: () => void;
}) {
  // Render rounds in canonical debate order, skipping any that have no
  // turns yet. judge_review is hidden in the funner UI — the verdict
  // section below is where the judge's voice lives.
  const order: DebateRound[] = ["opening", "cross_examination", "rebuttal", "closing"];
  const visibleTurnIds = new Set(visibleTurns.map((turn) => turn.id));
  const grouped = order.map((round) => ({
    round,
    turns: live.turns.filter((turn) => turn.round === round && visibleTurnIds.has(turn.id))
  }));
  const anyRoundStarted = grouped.some((g) => g.turns.length > 0);

  if (!anyRoundStarted) {
    return null;
  }

  return (
    <section className="space-y-4">
      {grouped.map(({ round, turns }) => {
        if (turns.length === 0) return null;
        const meta = friendlyRound[round];
        const pro = turns.find((t) => t.side === "pro");
        const con = turns.find((t) => t.side === "con");
        return (
          <article key={round} className="rounded-2xl border border-mud/20 bg-panel/90 p-5 shadow-sm">
            <header>
              <div className="text-sm font-black text-pond">{meta.title}</div>
              <div className="mt-0.5 text-xs text-ink/65">{meta.blurb}</div>
            </header>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              {pro ? (
                <Bubble
                  side="pro"
                  content={froglingsBubbleText(pro)}
                  name={froglingsFrogName("pro")}
                  onDone={onTurnComplete}
                />
              ) : null}
              {con ? (
                <Bubble
                  side="con"
                  content={froglingsBubbleText(con)}
                  name={froglingsFrogName("con")}
                  onDone={onTurnComplete}
                />
              ) : null}
            </div>
          </article>
        );
      })}
    </section>
  );
}

function Bubble({
  side,
  name,
  content,
  onDone
}: {
  side: "pro" | "con";
  name: string;
  content: string;
  onDone: () => void;
}) {
  const isPro = side === "pro";
  const bubbleRef = useRef<HTMLDivElement>(null);
  // Tracks whether the typewriter is currently revealing characters. The
  // FunFrog mouth chatters only while it is, and the frog sounds context
  // starts/stops a softly-looping chirp or croak for the same window.
  const [typing, setTyping] = useState(false);
  const sounds = useContext(FrogSoundsContext);

  // Drive audio off the typing flag, but only during alternating
  // speaking windows so the sounds have room to finish without looping
  // continuously for the whole statement.
  useEffect(() => {
    if (!typing) {
      sounds.stop(side);
      return;
    }

    scrollActiveFrogIntoView(bubbleRef.current);
    let stopTimer: number | null = null;
    const soundMs = 900;
    const repeatMs = 1800;

    const chirp = () => {
      sounds.play(side);
      if (stopTimer !== null) window.clearTimeout(stopTimer);
      stopTimer = window.setTimeout(() => {
        sounds.stop(side);
        stopTimer = null;
      }, soundMs);
    };

    chirp();
    const interval = window.setInterval(chirp, repeatMs);

    return () => {
      window.clearInterval(interval);
      if (stopTimer !== null) window.clearTimeout(stopTimer);
      sounds.stop(side);
    };
  }, [typing, side, sounds]);

  return (
    <div
      ref={bubbleRef}
      className={`hop-in flex gap-3 rounded-2xl border px-4 py-3 ${
        isPro ? "border-leaf/30 bg-mint/50" : "border-berry/30 bg-lily/40"
      }`}
    >
      <div className="shrink-0">
        <FunFrog mood={side} size={40} speaking={typing} bob={!typing} />
      </div>
      <div className="min-w-0">
        <div className="mb-1 text-xs font-black text-ink">{name}</div>
        <p className="text-sm leading-relaxed text-ink/85">
          <SlowPrint text={content} onTypingChange={setTyping} onComplete={onDone} />
        </p>
      </div>
    </div>
  );
}

function Verdict({
  live,
  readyForVerdict
}: {
  live: FroglingsLiveState;
  readyForVerdict: boolean;
}) {
  const sounds = useContext(FrogSoundsContext);
  const hasPlayedVerdictRef = useRef(false);
  const hasPlayedJudgeIntroRef = useRef(false);
  const verdictRef = useRef<HTMLElement>(null);
  const pendingVerdictRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (hasPlayedJudgeIntroRef.current || !sounds.ready || !readyForVerdict) return;
    if (live.summary || live.scorecard) return;
    if (live.status !== "debating" && live.status !== "judging") return;
    hasPlayedJudgeIntroRef.current = true;

    scrollActiveFrogIntoView(pendingVerdictRef.current);
    sounds.play("judge", { random: true });
    const timer = window.setTimeout(() => sounds.stop("judge"), 520);

    return () => {
      window.clearTimeout(timer);
      sounds.stop("judge");
    };
  }, [readyForVerdict, live.status, live.summary, live.scorecard, sounds]);

  useEffect(() => {
    if (hasPlayedVerdictRef.current || !readyForVerdict || !live.summary || !live.scorecard) return;
    hasPlayedVerdictRef.current = true;

    scrollActiveFrogIntoView(verdictRef.current);
    sounds.play("judge");
    const timer = window.setTimeout(() => sounds.stop("judge"), 420);

    return () => {
      window.clearTimeout(timer);
      sounds.stop("judge");
    };
  }, [readyForVerdict, live.summary, live.scorecard, sounds]);

  if (!readyForVerdict) return null;

  if (!live.summary || !live.scorecard) {
    if (live.status === "debating" || live.status === "judging") {
      const isJudging = live.status === "judging";
      return (
        <section
          ref={pendingVerdictRef}
          className="hop-in rounded-2xl border border-mud/20 bg-panel/90 p-5 shadow-lily"
        >
          <div className="flex items-center gap-3 text-sm text-mud/70">
            <FunFrog mood="judge" size={48} bob speaking={isJudging} />
            <div className="min-w-0">
              <div className="flex items-center gap-2 font-bold text-pond">
                {isJudging ? <Loader2 className="h-3.5 w-3.5 animate-spin text-leaf" /> : null}
                {froglingsVerdictPendingCopy(live.status)}
              </div>
              {isJudging ? (
                <div className="mt-1 text-xs text-ink/60">
                  The judge is checking both sides before picking a winner.
                </div>
              ) : null}
            </div>
          </div>
        </section>
      );
    }
    if (live.status === "complete" || live.done) {
      return (
        <section className="rounded-2xl border border-berry/30 bg-lily/30 p-5 shadow-lily">
          <div className="flex items-center gap-3 text-sm text-mud/70">
            <FunFrog mood="judge" size={48} />
            The judge frog could not pick a winner this time.
          </div>
        </section>
      );
    }
    return null;
  }
  const pct = Math.round(live.scorecard.confidence * 100);
  const verdictCopy = froglingsVerdictCopy(live.scorecard, live.topicKind);
  return (
    <section ref={verdictRef} className="rounded-2xl border border-mud/20 bg-panel/95 p-6 shadow-lily">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4 sm:max-w-xl">
          <div className="flex shrink-0 flex-col items-center gap-1">
            <FunFrog mood="judge" size={64} hop />
            <span className="rounded-full bg-[#9978b8]/15 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-[#5c4583]">
              Judge
            </span>
          </div>
          <div>
            <h2 className="text-xl font-black leading-snug text-pond">{verdictCopy.headline}</h2>
            <p className="mt-2 text-sm leading-relaxed text-ink/85">{verdictCopy.body}</p>
          </div>
        </div>
        <div className="flex flex-col items-end">
          <div className="text-[11px] font-bold uppercase tracking-wide text-mud/60">
            How sure?
          </div>
          <div className="mt-1 text-2xl font-black tabular-nums text-pond">{pct}%</div>
          <div className="mt-1 h-1.5 w-32 overflow-hidden rounded-full bg-mud/15">
            <div className="h-full bg-leaf" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>
    </section>
  );
}

function scrollActiveFrogIntoView(element: HTMLElement | null) {
  if (!element || typeof window === "undefined") return;

  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.requestAnimationFrame(() => {
    element.scrollIntoView({
      behavior: prefersReducedMotion ? "auto" : "smooth",
      block: "center",
      inline: "nearest"
    });
  });
}

function froglingsVerdictPendingCopy(status: DebateStatus): string {
  if (status === "judging") return "The judge frog is thinking about who made the better case...";
  return "The judge frog is listening until all four rounds are finished.";
}

function orderedFroglingsTurns(turns: RoundTurn[]) {
  const roundOrder: DebateRound[] = ["opening", "cross_examination", "rebuttal", "closing"];
  const sideOrder = { pro: 0, con: 1, neutral: 2 };
  return [...turns]
    .filter((turn) => roundOrder.includes(turn.round))
    .sort((a, b) => {
      const roundDiff = roundOrder.indexOf(a.round) - roundOrder.indexOf(b.round);
      if (roundDiff !== 0) return roundDiff;
      return sideOrder[a.side] - sideOrder[b.side];
    });
}

function froglingsBubbleText(turn: RoundTurn) {
  const text = simplifyForKids(stripSpeakerPrefix(turn.content, turn.agentName));
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((sentence) => sentence.trim()) ?? [text];
  const picked: string[] = [];

  for (const sentence of sentences) {
    if (!sentence) continue;
    const next = [...picked, sentence].join(" ");
    if (picked.length >= 2 || next.length > 300) break;
    picked.push(sentence);
  }

  const compressed = picked.length > 0 ? picked.join(" ") : text;
  return trimAtWord(compressed, 320);
}

function stripSpeakerPrefix(content: string, agentName: string) {
  const escapedName = agentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content
    .replace(new RegExp(`^${escapedName}:\\s*`, "i"), "")
    .replace(/^\w[\w\s-]{0,40}:\s*/, "");
}

function simplifyForKids(content: string) {
  return content
    .replace(/\((?:claim|src)[^)]+\)/gi, "")
    .replace(/\bYou says that\b/g, "You said that")
    .replace(/\byou says that\b/g, "you said that")
    .replace(/\bYou says\b/g, "You said")
    .replace(/\byou says\b/g, "you said")
    .replace(/["“]Resolved:\s*([^"”]+?)\.?["”]/gi, (_match, question: string) => `"${froglingsQuestionText(question)}"`)
    .replace(/\bResolved:\s*/gi, "")
    .replace(/^The (?:YES side|affirmative) case for ["“][^"”]+["”]\s+(?:is grounded in|starts with (?:this claim|the claim that):?)\s*/i, "The YES frog says ")
    .replace(/^The (?:YES side|affirmative) case .*? starts with (?:this claim|the claim that):?\s*/i, "The YES frog says ")
    .replace(/^The (?:NO side|negative) case (?:against ["“][^"”]+["”]\s+)?(?:challenges the question by )?(?:asserting|saying|arguing):?\s*(?:that\s*)?/i, "The NO frog says ")
    .replace(/^The (?:NO side|negative) case challenges the question by (?:asserting|saying|arguing):?\s*/i, "The NO frog says ")
    .replace(/\bpro side's\b/gi, "YES side's")
    .replace(/\bcon side's\b/gi, "NO side's")
    .replace(/\bpro side\b/gi, "YES side")
    .replace(/\bcon side\b/gi, "NO side")
    .replace(/\bpro case\b/gi, "YES case")
    .replace(/\bcon case\b/gi, "NO case")
    .replace(/\bvote pro\b/gi, "vote YES")
    .replace(/\bvote con\b/gi, "vote NO")
    .replace(/\baffirmative\b/gi, "YES side")
    .replace(/\bnegative\b/gi, "NO side")
    .replace(/\bYES side side\b/gi, "YES side")
    .replace(/\bNO side side\b/gi, "NO side")
    .replace(/\bpro\b/gi, "YES")
    .replace(/\bcon\b/gi, "NO")
    .replace(/\basserts?\b/gi, "says")
    .replace(/\bindicates?\b/gi, "shows")
    .replace(/\bsubstantial\b/gi, "big")
    .replace(/\bimplementation of\b/gi, "using")
    .replace(/\bacademic achievement\b/gi, "school performance")
    .replace(/\blogistical challenges\b/gi, "planning problems")
    .replace(/\bresolution\b/gi, "question")
    .replace(/\bstudies shows\b/gi, "studies show")
    .replace(/\s+/g, " ")
    .trim();
}

function froglingsQuestionText(input: string) {
  const cleaned = input
    .replace(/^Resolved:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (/^should\b/i.test(cleaned)) return `${cleaned.replace(/[.!?]+$/, "")}?`;
  return cleaned.replace(/\.$/, "");
}

function literalQuestionText(input: string) {
  return input.replace(/\s+/g, " ").trim();
}

function froglingsFrogName(side: "pro" | "con") {
  return side === "pro" ? "Yes Frog" : "No Frog";
}

function trimAtWord(content: string, maxLength: number) {
  if (content.length <= maxLength) return content;
  const slice = content.slice(0, maxLength).trim();
  const lastSpace = slice.lastIndexOf(" ");
  const trimmed = slice.slice(0, lastSpace > 180 ? lastSpace : maxLength).replace(/[,:;.-]+$/, "");
  return `${trimmed}.`;
}

function froglingsVerdictCopy(scorecard: Scorecard, topicKind?: TopicKind) {
  const topicCopy = froglingsVerdictTopicCopy(topicKind);

  switch (scorecard.recommendation) {
    case "lean_yes":
      return {
        headline: "The judge gives this one to YES.",
        body: "The YES frog made the stronger case, but the NO frog still raised some things to watch."
      };
    case "conditional_yes":
      return {
        headline: topicCopy.conditionalYesHeadline,
        body: topicCopy.conditionalYesBody
      };
    case "lean_no":
      return {
        headline: "The judge gives this one to NO.",
        body: "The NO frog made the stronger case, though the YES frog had some good reasons too."
      };
    case "conditional_no":
      return {
        headline: topicCopy.conditionalNoHeadline,
        body: topicCopy.conditionalNoBody
      };
    case "mixed":
    default:
      return {
        headline: "The judge says this one is close.",
        body: "Both frogs made good points. The best answer depends on which reasons matter most."
      };
  }
}

function froglingsVerdictTopicCopy(topicKind?: TopicKind) {
  switch (topicKind) {
    case "policy":
    case "decision":
      return {
        conditionalYesHeadline: "The judge says: probably YES, with care.",
        conditionalYesBody:
          "The YES frog made the stronger case, but the idea would need clear rules and checks along the way.",
        conditionalNoHeadline: "The judge says: probably NO, unless things change.",
        conditionalNoBody:
          "The NO frog made the stronger case for now. Better evidence or a safer plan could change the answer."
      };
    case "empirical":
    case "comparison":
      return {
        conditionalYesHeadline: "The judge says: probably YES.",
        conditionalYesBody:
          "The YES frog made the stronger case from the evidence shown, though the answer is not completely certain.",
        conditionalNoHeadline: "The judge says: probably NO.",
        conditionalNoBody:
          "The NO frog made the stronger case from the evidence shown, though the answer is not completely certain."
      };
    case "value":
    default:
      return {
        conditionalYesHeadline: "The judge says: probably YES.",
        conditionalYesBody:
          "The YES frog made the stronger case, but the answer depends on which reasons matter most.",
        conditionalNoHeadline: "The judge says: probably NO.",
        conditionalNoBody:
          "The NO frog made the stronger case, but the answer depends on which reasons matter most."
      };
  }
}
