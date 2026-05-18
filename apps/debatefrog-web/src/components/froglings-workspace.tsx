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
 *  - Phase 7: first-visit FroglingsIntro overlay (sessionStorage-gated)
 *             + per-round explainer banner on the live stage.
 */

const INTRO_SEEN_KEY = "froglings:intro-seen";

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
import { Loader2, RotateCcw, Send, Volume2, VolumeX } from "lucide-react";
import { FunFrog } from "@/components/fun-frog";
import { SlowPrint } from "@/components/slow-print";
import { useFrogSounds } from "@/components/use-frog-sounds";
import { FroglingsIntro } from "@/components/froglings-intro";
import type {
  Claim,
  DebateLiveEvent,
  DebateRecord,
  DebateRound,
  DebateStatus,
  DebateSummary,
  DebateTeam,
  RoundTurn,
  Scorecard
} from "@polyvise/debate-engine/debate/types";

const kidPrompts = [
  "Should schools have longer recess?",
  "Should kids be allowed to vote?",
  "Should video games count as exercise?",
  "Should pets be allowed at school?",
  "Should homework be banned?"
];

/**
 * Plain-language stage labels for younger readers. The engine emits the
 * same DebateStatus values as the grown-up app — we just rename them.
 */
const friendlyStage: Record<DebateStatus, string> = {
  queued: "the frogs are getting ready",
  framing: "the frogs are picking the question",
  researching: "the frogs are looking up facts",
  debating: "the frogs are arguing!",
  judging: "the judge frog is thinking",
  complete: "all done!",
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
// Live state — a slim version of the grown-up app's reducer. We only keep
// the fields the funner UI renders.
// -------------------------------------------------------------------------

type FroglingsLiveState = {
  debateId: string;
  subject: string;
  status: DebateStatus;
  resolution?: string;
  teams: DebateTeam | null;
  claims: Claim[];
  turns: RoundTurn[];
  scorecard: Scorecard | null;
  summary: DebateSummary | null;
  errorMessage: string | null;
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
      turns: [],
      scorecard: null,
      summary: null,
      errorMessage: null,
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
      teams: run.teams,
      claims: run.claims,
      turns: run.turns,
      scorecard: run.scorecard,
      summary: run.summary,
      errorMessage: null,
      done: action.debate.status === "complete" || action.debate.status === "failed"
    };
  }
  if (!state) return state;
  const event = action.event;
  switch (event.kind) {
    case "stage":
      return { ...state, status: event.status };
    case "framed":
      return { ...state, resolution: event.resolution };
    case "teams":
      return { ...state, teams: event.teams };
    case "claims":
      // In duo mode placeholder fallbacks would be a corner case; the
      // funner UI hides claims rather than showing fallback text.
      return { ...state, claims: event.placeholder ? state.claims : event.claims };
    case "turns":
      return { ...state, turns: event.placeholder ? state.turns : [...state.turns, ...event.turns] };
    case "scorecard":
      return { ...state, scorecard: event.placeholder ? null : event.scorecard };
    case "summary":
      return { ...state, summary: event.placeholder ? null : event.summary };
    case "complete":
      return { ...state, status: "complete", done: true };
    case "error":
      return { ...state, status: "failed", done: true, errorMessage: event.message };
    default:
      return state;
  }
}

// -------------------------------------------------------------------------
// Tiny context so Bubble can trigger play/stop without prop-drilling.
// -------------------------------------------------------------------------

type FrogSoundsCtx = {
  play: (side: "pro" | "con") => void;
  stop: (side: "pro" | "con") => void;
};

const noopSounds: FrogSoundsCtx = { play: () => {}, stop: () => {} };
const FrogSoundsContext = createContext<FrogSoundsCtx>(noopSounds);

// -------------------------------------------------------------------------
// Top-level workspace
// -------------------------------------------------------------------------

export function FroglingsWorkspace() {
  const [subject, setSubject] = useState(kidPrompts[0]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [live, dispatch] = useReducer(liveReducer, null);
  const [, setDebate] = useState<DebateRecord | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const sounds = useFrogSounds();
  // Show the intro on first session only. We default to false on the
  // server (so the overlay never SSRs and flashes), then flip to true
  // after mount if sessionStorage says we haven't shown it yet.
  const [showIntro, setShowIntro] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const seen = window.sessionStorage.getItem(INTRO_SEEN_KEY);
      if (seen !== "1") setShowIntro(true);
    } catch {
      // sessionStorage may be unavailable; just skip the overlay.
    }
  }, []);

  const dismissIntro = () => {
    setShowIntro(false);
    try {
      if (typeof window !== "undefined") {
        window.sessionStorage.setItem(INTRO_SEEN_KEY, "1");
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
      const response = await fetch("/api/debates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject,
          mode: "hybrid_council",
          evidence: "cited",
          // The whole point of the funner version: ask the engine for
          // the simpler 1-on-1 shape.
          councilSize: "duo"
        })
      });
      const payload = (await response.json()) as { debate?: DebateRecord; error?: string };
      if (!response.ok || !payload.debate) {
        throw new Error(payload.error ?? "The pond is murky today. Try again.");
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
          const finalRes = await fetch(`/api/debates/${seed.id}`, { cache: "no-store" });
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
        <div className="flex items-center gap-3 text-pond">
          <FunFrog mood="idle" size={42} bob={false} />
          <span className="text-lg font-black tracking-tight">Froglings</span>
          <span className="rounded-full bg-mint px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-pond">
            Funner version
          </span>
        </div>
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
          <Link
            href={"/" as Route}
            className="text-xs font-semibold text-pond/60 transition hover:text-pond"
          >
            ← Grown-up version
          </Link>
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
        <FrogSoundsContext.Provider value={{ play: sounds.play, stop: sounds.stop }}>
          <FroglingsLive live={live} />
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
        <p className="text-[10px] text-pond/45">
          Frog sounds:{" "}
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
    </main>
  );
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
  return (
    <section className="mt-6 grid gap-8 lg:mt-10 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
      <div className="flex flex-col justify-center">
        <h1
          className="font-black leading-[0.95] text-pond"
          style={{ fontSize: "clamp(2.4rem, 6vw, 4rem)" }}
        >
          Two frogs.
          <br />
          One big question.
        </h1>
        <p className="mt-4 max-w-[480px] text-base leading-relaxed text-ink/80">
          One pro frog and one con frog will debate your question. The judge frog picks the winner.
          You get to watch the whole thing!
        </p>
        <div className="mt-5 flex items-center gap-3">
          <div className="flex flex-col items-center">
            <FunFrog mood="pro" size={64} />
            <span className="mt-1 text-[11px] font-black uppercase tracking-wide text-pond">
              Pro frog
            </span>
          </div>
          <span className="text-sm font-black text-mud/60">vs.</span>
          <div className="flex flex-col items-center">
            <FunFrog mood="con" size={64} />
            <span className="mt-1 text-[11px] font-black uppercase tracking-wide text-berry">
              Con frog
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
          placeholder="Should...?"
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

function FroglingsLive({ live }: { live: FroglingsLiveState }) {
  const staged = useStagedFroglingsTurns(live);

  return (
    <div className="mt-6 space-y-5">
      <QuestionBanner live={live} isCatchingUp={!staged.readyForVerdict} />
      {live.status === "failed" ? (
        <div className="rounded-xl border border-berry/40 bg-berry/10 px-4 py-3 text-sm text-berry">
          {live.errorMessage ?? "The debate hopped off the lily pad."}
        </div>
      ) : null}
      {live.teams ? <FrogIntros teams={live.teams} /> : null}
      <CurrentRoundCallout live={live} visibleTurns={staged.visibleTurns} />
      <Rounds live={live} visibleTurns={staged.visibleTurns} onTurnComplete={staged.showNextTurn} />
      <Verdict live={live} readyForVerdict={staged.readyForVerdict} />
    </div>
  );
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
  const readyForVerdict = debateTurns.length === 0 || visibleTurns.length >= debateTurns.length;

  return { visibleTurns, readyForVerdict, showNextTurn };
}

function QuestionBanner({
  live,
  isCatchingUp
}: {
  live: FroglingsLiveState;
  isCatchingUp: boolean;
}) {
  const isActuallyDone = (live.status === "complete" || live.done) && !isCatchingUp;
  const stageCopy = isCatchingUp ? "the frogs are taking turns" : friendlyStage[live.status];

  return (
    <section className="rounded-2xl border border-mud/20 bg-panel/90 p-5 shadow-lily">
      <div className="text-[11px] font-extrabold uppercase tracking-wide text-mud/60">
        Question
      </div>
      <div className="mt-1 text-lg leading-snug text-ink">{live.resolution ?? live.subject}</div>
      <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-cream/70 px-3 py-1 text-xs font-bold text-mud">
        {isActuallyDone ? null : (
          <Loader2 className="h-3 w-3 animate-spin text-leaf" />
        )}
        {stageCopy}
      </div>
    </section>
  );
}

function FrogIntros({ teams }: { teams: DebateTeam }) {
  const pro = teams.pro[0];
  const con = teams.con[0];
  return (
    <section className="grid gap-3 md:grid-cols-2">
      <div className="flex items-center gap-3 rounded-2xl border border-leaf/30 bg-mint/40 p-3">
        <FunFrog mood="pro" size={56} hop />
        <div className="min-w-0">
          <div className="text-[11px] font-black uppercase tracking-wide text-pond">Pro frog</div>
          <div className="mt-0.5 text-sm font-bold text-ink truncate">{pro?.name ?? "—"}</div>
          <div className="text-xs text-ink/60">Will say YES to the question</div>
        </div>
      </div>
      <div className="flex items-center gap-3 rounded-2xl border border-berry/30 bg-lily/40 p-3">
        <FunFrog mood="con" size={56} hop />
        <div className="min-w-0">
          <div className="text-[11px] font-black uppercase tracking-wide text-berry">Con frog</div>
          <div className="mt-0.5 text-sm font-bold text-ink truncate">{con?.name ?? "—"}</div>
          <div className="text-xs text-ink/60">Will say NO to the question</div>
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
  visibleTurns
}: {
  live: FroglingsLiveState;
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
  if (live.status === "judging" || live.status === "complete") return null;

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
    return (
      <section className="rounded-2xl border border-dashed border-mud/25 bg-cream/40 p-6 text-center text-sm text-ink/65">
        <span className="inline-flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-leaf" />
          The frogs are warming up their voices…
        </span>
      </section>
    );
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
                  name={pro.agentName}
                  onDone={onTurnComplete}
                />
              ) : null}
              {con ? (
                <Bubble
                  side="con"
                  content={froglingsBubbleText(con)}
                  name={con.agentName}
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
  // Tracks whether the typewriter is currently revealing characters. The
  // FunFrog mouth chatters only while it is, and the frog sounds context
  // starts/stops a softly-looping chirp or croak for the same window.
  const [typing, setTyping] = useState(false);
  const sounds = useContext(FrogSoundsContext);

  // Drive audio off the typing flag. We start on rising edge, stop on
  // falling edge, and also stop on unmount so a navigation or new debate
  // doesn't leave a frog chirping in the background.
  useEffect(() => {
    if (typing) {
      sounds.play(side);
    } else {
      sounds.stop(side);
    }
    return () => sounds.stop(side);
  }, [typing, side, sounds]);

  return (
    <div
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
  if (!readyForVerdict) return null;

  if (!live.summary || !live.scorecard) {
    if (live.status === "debating" || live.status === "judging") {
      return (
        <section className="rounded-2xl border border-mud/20 bg-panel/90 p-5 shadow-lily">
          <div className="flex items-center gap-3 text-sm text-mud/70">
            <FunFrog mood="judge" size={48} bob={live.status === "debating"} />
            {froglingsVerdictPendingCopy(live.status)}
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
  const verdictCopy = froglingsVerdictCopy(live.scorecard);
  return (
    <section className="rounded-2xl border border-mud/20 bg-panel/95 p-6 shadow-lily">
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
    .replace(/^The YES side case .*? starts with the claim that\s*/i, "The YES frog says ")
    .replace(/^The NO side case challenges the question by (?:asserting|saying) that\s*/i, "The NO frog says ")
    .replace(/\baffirmative\b/gi, "YES side")
    .replace(/\bnegative\b/gi, "NO side")
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

function trimAtWord(content: string, maxLength: number) {
  if (content.length <= maxLength) return content;
  const slice = content.slice(0, maxLength).trim();
  const lastSpace = slice.lastIndexOf(" ");
  const trimmed = slice.slice(0, lastSpace > 180 ? lastSpace : maxLength).replace(/[,:;.-]+$/, "");
  return `${trimmed}.`;
}

function froglingsVerdictCopy(scorecard: Scorecard) {
  switch (scorecard.recommendation) {
    case "lean_yes":
      return {
        headline: "The judge gives this one to YES.",
        body: "The YES frog made the stronger case, but the NO frog still raised some things to watch."
      };
    case "conditional_yes":
      return {
        headline: "The judge says: probably YES, with care.",
        body: "The YES frog made the stronger case, but only if the plan has clear rules and checks along the way."
      };
    case "lean_no":
      return {
        headline: "The judge gives this one to NO.",
        body: "The NO frog made the stronger case, though the YES frog had some good reasons too."
      };
    case "conditional_no":
      return {
        headline: "The judge says: probably NO, unless things change.",
        body: "The NO frog made the stronger case for now. Better evidence or a safer plan could change the answer."
      };
    case "mixed":
    default:
      return {
        headline: "The judge says this one is close.",
        body: "Both frogs made good points. The best answer depends on which reasons matter most."
      };
  }
}
