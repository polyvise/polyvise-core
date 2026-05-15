"use client";

import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  BookOpenCheck,
  Brain,
  ClipboardList,
  FileText,
  GitFork,
  History,
  Layers3,
  Loader2,
  MessageSquarePlus,
  Scale,
  SearchCheck,
  SendHorizontal,
  Sparkles
} from "lucide-react";
import { FormEvent, useMemo, useRef, useState } from "react";
import { ArgumentMap } from "@/components/argument-map";
import type {
  Claim,
  DebateRecord,
  DebateRound,
  EvidenceSource,
  ProductNote,
  RoundTurn,
  Scorecard
} from "@polyvise/debate-engine/debate/types";

type ActiveTab = "brief" | "pros-cons" | "map" | "transcript" | "sources";

const examples = [
  "Should a small company adopt AI customer support this year?",
  "Should cities ban private cars from dense downtown cores?",
  "Is nuclear power a good climate strategy?",
  "Should I choose a fully remote job over a higher-paying hybrid offer?",
  "Should schools allow phones during the day?"
];

const staticProductNotes: ProductNote[] = [
  {
    id: "note-debate-showcase",
    title: "Debate Showcase",
    mode: "debate_showcase",
    note: "Future mode for polished, shareable, well-enacted debates.",
    priority: "candidate"
  },
  {
    id: "note-model-lab",
    title: "Model Lab",
    mode: "model_lab",
    note: "Future mode for comparing model performance by topic, cost, latency, and citation quality.",
    priority: "research"
  }
];

const tabs: Array<{ id: ActiveTab; label: string; icon: typeof FileText }> = [
  { id: "brief", label: "Decision Brief", icon: FileText },
  { id: "pros-cons", label: "Pros / Cons", icon: Scale },
  { id: "map", label: "Argument Map", icon: GitFork },
  { id: "transcript", label: "Full Debate", icon: History },
  { id: "sources", label: "Source Ledger", icon: BookOpenCheck }
];

export function DebateWorkspace() {
  const [subject, setSubject] = useState("");
  const [context, setContext] = useState("");
  const [debate, setDebate] = useState<DebateRecord | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>("brief");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [followupQuestion, setFollowupQuestion] = useState("");
  const [isFollowupLoading, setIsFollowupLoading] = useState(false);
  const resultRef = useRef<HTMLElement | null>(null);

  const notes = debate?.productNotes ?? staticProductNotes;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/debates", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          subject,
          context: context || undefined,
          mode: "hybrid_council",
          evidence: "cited"
        })
      });

      const payload = (await response.json()) as { debate?: DebateRecord; error?: string };

      if (!response.ok || !payload.debate) {
        throw new Error(payload.error ?? "Unable to create debate.");
      }

      setDebate(payload.debate);
      setActiveTab("brief");
      requestAnimationFrame(() => {
        resultRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start"
        });
      });
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to create debate.");
    } finally {
      setIsSubmitting(false);
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
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          question: followupQuestion
        })
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error ?? "Unable to answer follow-up.");
      }

      const refreshed = await fetch(`/api/debates/${debate.id}`, {
        cache: "no-store"
      });
      const refreshedPayload = (await refreshed.json()) as { debate: DebateRecord };
      setDebate(refreshedPayload.debate);
      setFollowupQuestion("");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to answer follow-up.");
    } finally {
      setIsFollowupLoading(false);
    }
  }

  return (
    <main className="min-h-screen">
      <section className="mx-auto flex w-full max-w-[1480px] flex-col gap-6 px-4 py-5 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 border-b border-graphite/15 pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.18em] text-jade">
              <Brain className="h-4 w-4" />
              Polyvise
            </div>
            <h1 className="text-4xl font-semibold leading-tight text-ink sm:text-5xl">Debate a decision from every side.</h1>
          </div>
          <div className="grid grid-cols-3 gap-2 text-sm text-graphite/75 sm:min-w-[420px]">
            <StatusChip icon={Layers3} label="Hybrid Council" />
            <StatusChip icon={SearchCheck} label="Cited by default" />
            <StatusChip icon={BadgeCheck} label="Decision support" />
          </div>
        </header>

        <div className="grid gap-6 xl:grid-cols-[420px_minmax(0,1fr)]">
          <aside className="space-y-4">
            <form onSubmit={handleSubmit} className="rounded-lg border border-graphite/15 bg-panel p-4 shadow-panel">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-ink">Subject</h2>
                  <p className="text-sm text-graphite/70">Free text in, cited debate out.</p>
                </div>
                <Scale className="h-5 w-5 text-jade" />
              </div>

              <label className="mb-2 block text-sm font-semibold text-graphite" htmlFor="subject">
                Debate subject
              </label>
              <textarea
                id="subject"
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                placeholder="Should my team adopt an AI support agent this quarter?"
                className="min-h-[130px] w-full resize-y rounded-lg border border-graphite/20 bg-white px-3 py-3 text-base leading-relaxed text-ink shadow-inner outline-none transition focus:border-jade"
              />

              <label className="mb-2 mt-4 block text-sm font-semibold text-graphite" htmlFor="context">
                Context
              </label>
              <textarea
                id="context"
                value={context}
                onChange={(event) => setContext(event.target.value)}
                placeholder="Constraints, audience, time horizon, stakes, or what you already believe."
                className="min-h-[100px] w-full resize-y rounded-lg border border-graphite/20 bg-white px-3 py-3 text-sm leading-relaxed text-ink shadow-inner outline-none transition focus:border-jade"
              />

              {error ? (
                <div className="mt-4 flex gap-2 rounded-lg border border-coral/30 bg-coral/10 p-3 text-sm text-graphite">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-coral" />
                  <span>{error}</span>
                </div>
              ) : null}

              <button
                type="submit"
                disabled={isSubmitting || subject.trim().length < 4}
                className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-ink px-4 py-3 text-sm font-semibold text-white transition hover:bg-graphite disabled:cursor-not-allowed disabled:bg-graphite/35"
              >
                {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <SendHorizontal className="h-4 w-4" />}
                Run Hybrid Council
              </button>
            </form>

            <section className="rounded-lg border border-graphite/15 bg-panel p-4">
              <div className="mb-3 flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-saffron" />
                <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-graphite">Examples</h2>
              </div>
              <div className="grid gap-2">
                {examples.map((example) => (
                  <button
                    key={example}
                    type="button"
                    onClick={() => setSubject(example)}
                    className="flex items-start justify-between gap-3 rounded-lg border border-graphite/15 bg-white px-3 py-2.5 text-left text-sm leading-snug text-graphite transition hover:border-jade/50 hover:text-ink"
                  >
                    <span>{example}</span>
                    <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-jade" />
                  </button>
                ))}
              </div>
            </section>

            <ProductNotes notes={notes} />
          </aside>

          <section ref={resultRef} className="min-w-0 scroll-mt-4">
            {debate ? (
              <DebateResult
                debate={debate}
                activeTab={activeTab}
                onTabChange={setActiveTab}
                followupQuestion={followupQuestion}
                onFollowupQuestionChange={setFollowupQuestion}
                onFollowupSubmit={handleFollowup}
                isFollowupLoading={isFollowupLoading}
              />
            ) : (
              <EmptyState />
            )}
          </section>
        </div>
      </section>
    </main>
  );
}

function DebateResult({
  debate,
  activeTab,
  onTabChange,
  followupQuestion,
  onFollowupQuestionChange,
  onFollowupSubmit,
  isFollowupLoading
}: {
  debate: DebateRecord;
  activeTab: ActiveTab;
  onTabChange: (tab: ActiveTab) => void;
  followupQuestion: string;
  onFollowupQuestionChange: (question: string) => void;
  onFollowupSubmit: (event: FormEvent<HTMLFormElement>) => void;
  isFollowupLoading: boolean;
}) {
  const run = debate.latestRun;
  const summary = run?.summary;

  if (!run || !summary) {
    return (
      <div className="rounded-lg border border-graphite/15 bg-panel p-6">
        <ProgressRail debate={debate} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-graphite/15 bg-panel p-5 shadow-panel">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-4xl">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-jade">
              <span>{debate.topicKind}</span>
              <span className="text-graphite/30">/</span>
              <span>{debate.status}</span>
              <span className="text-graphite/30">/</span>
              <span>{Math.round(summary.confidence * 100)}% confidence</span>
            </div>
            <h2 className="text-2xl font-semibold leading-tight text-ink">{debate.resolution}</h2>
          </div>
          <div className="rounded-lg border border-jade/20 bg-jade/10 px-3 py-2 text-sm font-semibold text-jade">
            {formatRecommendation(run.scorecard.recommendation)}
          </div>
        </div>

        {summary.highStakesDisclaimer ? (
          <div className="mt-4 flex gap-2 rounded-lg border border-saffron/35 bg-saffron/10 p-3 text-sm text-graphite">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-saffron" />
            <span>{summary.highStakesDisclaimer}</span>
          </div>
        ) : null}

        <div className="mt-4">
          <ProgressRail debate={debate} />
        </div>
      </section>

      <section className="rounded-lg border border-graphite/15 bg-panel p-3">
        <div className="flex flex-wrap gap-2">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const selected = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => onTabChange(tab.id)}
                className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition ${
                  selected ? "bg-ink text-white" : "bg-white text-graphite hover:bg-linen"
                }`}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </section>

      {activeTab === "brief" ? <DecisionBrief debate={debate} /> : null}
      {activeTab === "pros-cons" ? <ProsCons claims={run.claims} scorecard={run.scorecard} /> : null}
      {activeTab === "map" ? <ArgumentMap nodes={run.argumentNodes} edges={run.argumentEdges} /> : null}
      {activeTab === "transcript" ? <Transcript turns={run.turns} /> : null}
      {activeTab === "sources" ? <SourceLedger debate={debate} /> : null}

      <section className="rounded-lg border border-graphite/15 bg-panel p-4">
        <form onSubmit={onFollowupSubmit} className="flex flex-col gap-3 md:flex-row">
          <input
            value={followupQuestion}
            onChange={(event) => onFollowupQuestionChange(event.target.value)}
            placeholder="Ask a follow-up about risks, evidence, or what would change the answer."
            className="min-h-11 flex-1 rounded-lg border border-graphite/20 bg-white px-3 text-sm text-ink outline-none transition focus:border-jade"
          />
          <button
            type="submit"
            disabled={isFollowupLoading || followupQuestion.trim().length < 4}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-jade px-4 py-2 text-sm font-semibold text-white transition hover:bg-jade/90 disabled:cursor-not-allowed disabled:bg-graphite/35"
          >
            {isFollowupLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquarePlus className="h-4 w-4" />}
            Ask
          </button>
        </form>

        {debate.followups.length > 0 ? (
          <div className="mt-4 grid gap-3">
            {debate.followups.map((followup) => (
              <div key={followup.id} className="rounded-lg border border-graphite/15 bg-white p-3">
                <div className="mb-1 text-sm font-semibold text-ink">{followup.question}</div>
                <p className="text-sm leading-relaxed text-graphite/75">{followup.answer}</p>
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function DecisionBrief({ debate }: { debate: DebateRecord }) {
  const run = debate.latestRun;
  const summary = run?.summary;

  if (!run || !summary) {
    return null;
  }

  return (
    <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="rounded-lg border border-graphite/15 bg-panel p-5">
        <div className="mb-4 flex items-center gap-2">
          <ClipboardList className="h-5 w-5 text-jade" />
          <h2 className="text-xl font-semibold text-ink">{summary.headline}</h2>
        </div>
        <p className="text-base leading-7 text-graphite">{summary.recommendation}</p>

        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <BriefList title="Strongest pro" items={summary.strongestPro} tone="pro" />
          <BriefList title="Strongest con" items={summary.strongestCon} tone="con" />
          <BriefList title="Unresolved" items={summary.unresolvedUncertainties} tone="neutral" />
          <BriefList title="Would change mind" items={summary.whatWouldChangeMind} tone="neutral" />
        </div>
      </div>

      <aside className="rounded-lg border border-graphite/15 bg-panel p-5">
        <h3 className="mb-4 text-sm font-semibold uppercase tracking-[0.14em] text-graphite">Scorecard</h3>
        <ScorecardBars scorecard={run.scorecard} />
      </aside>
    </section>
  );
}

function ProsCons({ claims, scorecard }: { claims: Claim[]; scorecard: Scorecard }) {
  const proClaims = claims.filter((claim) => claim.side === "pro");
  const conClaims = claims.filter((claim) => claim.side === "con");

  return (
    <section className="grid gap-4 lg:grid-cols-2">
      <ClaimColumn title="Pros" claims={proClaims} tone="pro" />
      <ClaimColumn title="Cons" claims={conClaims} tone="con" />
      <div className="rounded-lg border border-graphite/15 bg-panel p-4 lg:col-span-2">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-[0.14em] text-graphite">Category Notes</h3>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {scorecard.categories.map((category) => (
            <div key={category.name} className="rounded-lg border border-graphite/15 bg-white p-3">
              <div className="mb-1 text-sm font-semibold capitalize text-ink">{category.name}</div>
              <p className="text-sm leading-relaxed text-graphite/75">{category.note}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Transcript({ turns }: { turns: RoundTurn[] }) {
  const grouped = useMemo(() => groupTurns(turns), [turns]);

  return (
    <section className="rounded-lg border border-graphite/15 bg-panel p-5">
      <div className="grid gap-5">
        {Object.entries(grouped).map(([round, roundTurns]) => (
          <div key={round}>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-[0.14em] text-graphite">
              {formatRound(round as DebateRound)}
            </h3>
            <div className="grid gap-3">
              {roundTurns.map((turn) => (
                <article key={turn.id} className="rounded-lg border border-graphite/15 bg-white p-4">
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-semibold text-ink">{turn.agentName}</span>
                    <SideBadge side={turn.side} />
                  </div>
                  <p className="leading-7 text-graphite">{turn.content}</p>
                </article>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function SourceLedger({ debate }: { debate: DebateRecord }) {
  const run = debate.latestRun;
  if (!run) {
    return null;
  }

  return (
    <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="rounded-lg border border-graphite/15 bg-panel p-5">
        <h2 className="mb-4 text-xl font-semibold text-ink">Source Ledger</h2>
        <div className="grid gap-3">
          {run.sources.map((source) => (
            <SourceCard key={source.id} source={source} />
          ))}
        </div>
      </div>
      <aside className="space-y-4">
        <div className="rounded-lg border border-graphite/15 bg-panel p-4">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-[0.14em] text-graphite">Model Roster</h3>
          <div className="grid gap-2">
            {run.modelSnapshots.map((snapshot) => (
              <div key={snapshot.id} className="rounded-lg border border-graphite/15 bg-white p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-ink">{snapshot.model}</span>
                  <span className={snapshot.configured ? "text-xs font-semibold text-jade" : "text-xs font-semibold text-saffron"}>
                    {snapshot.configured ? "configured" : "mock-ready"}
                  </span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-graphite/70">{snapshot.role}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-graphite/15 bg-panel p-4">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-[0.14em] text-graphite">Run Trace</h3>
          <div className="grid gap-2">
            {run.trace.map((entry) => (
              <div key={entry.id} className="rounded-lg border border-graphite/15 bg-white p-3">
                <div className="text-sm font-semibold capitalize text-ink">{entry.step.replace("_", " ")}</div>
                <p className="text-xs leading-relaxed text-graphite/70">{entry.message}</p>
              </div>
            ))}
          </div>
        </div>
      </aside>
    </section>
  );
}

function EmptyState() {
  return (
    <div className="grid min-h-[680px] place-items-center rounded-lg border border-dashed border-graphite/25 bg-panel/70 p-8 text-center">
      <div className="max-w-2xl">
        <Scale className="mx-auto mb-5 h-12 w-12 text-jade" />
        <h2 className="text-3xl font-semibold leading-tight text-ink">Enter a subject to convene the council.</h2>
        <p className="mx-auto mt-3 max-w-xl text-base leading-7 text-graphite/75">
          Polyvise will frame the resolution, assign pro and con agents, attach citations, and synthesize the result into a
          decision brief.
        </p>
      </div>
    </div>
  );
}

function ProductNotes({ notes }: { notes: ProductNote[] }) {
  return (
    <section className="rounded-lg border border-graphite/15 bg-panel p-4">
      <div className="mb-3 flex items-center gap-2">
        <Layers3 className="h-4 w-4 text-plum" />
        <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-graphite">Future Modes</h2>
      </div>
      <div className="grid gap-3">
        {notes.map((note) => (
          <article key={note.id} className="rounded-lg border border-graphite/15 bg-white p-3">
            <div className="mb-1 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-ink">{note.title}</h3>
              <span className="rounded-full bg-linen px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-graphite/70">
                {note.priority}
              </span>
            </div>
            <p className="text-sm leading-relaxed text-graphite/75">{note.note}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function ProgressRail({ debate }: { debate: DebateRecord }) {
  const events = debate.latestRun?.events ?? [];
  const eventStatuses = new Set(events.map((event) => event.status));
  const stages = ["queued", "framing", "researching", "debating", "judging", "complete"] as const;

  return (
    <div className="grid gap-2 md:grid-cols-6">
      {stages.map((stage) => {
        const complete = eventStatuses.has(stage) || debate.status === "complete";
        return (
          <div
            key={stage}
            className={`rounded-lg border px-3 py-2 text-sm ${
              complete ? "border-jade/30 bg-jade/10 text-jade" : "border-graphite/15 bg-white text-graphite/55"
            }`}
          >
            <div className="font-semibold capitalize">{stage}</div>
          </div>
        );
      })}
    </div>
  );
}

function StatusChip({ icon: Icon, label }: { icon: typeof Layers3; label: string }) {
  return (
    <div className="flex min-h-10 items-center justify-center gap-2 rounded-lg border border-graphite/15 bg-panel px-2 text-center font-semibold">
      <Icon className="h-4 w-4 shrink-0 text-jade" />
      <span className="leading-tight">{label}</span>
    </div>
  );
}

function BriefList({ title, items, tone }: { title: string; items: string[]; tone: "pro" | "con" | "neutral" }) {
  const toneClass =
    tone === "pro"
      ? "border-jade/25 bg-jade/10"
      : tone === "con"
        ? "border-coral/25 bg-coral/10"
        : "border-graphite/15 bg-white";

  return (
    <div className={`rounded-lg border p-4 ${toneClass}`}>
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-[0.12em] text-graphite">{title}</h3>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item} className="text-sm leading-relaxed text-graphite">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ClaimColumn({ title, claims, tone }: { title: string; claims: Claim[]; tone: "pro" | "con" }) {
  return (
    <section className="rounded-lg border border-graphite/15 bg-panel p-5">
      <h2 className={`mb-4 text-xl font-semibold ${tone === "pro" ? "text-jade" : "text-coral"}`}>{title}</h2>
      <div className="grid gap-3">
        {claims.map((claim) => (
          <article key={claim.id} className="rounded-lg border border-graphite/15 bg-white p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <SideBadge side={claim.side} />
              <span className="text-xs font-semibold text-graphite/55">{Math.round(claim.confidence * 100)}%</span>
            </div>
            <p className="text-sm font-semibold leading-relaxed text-ink">{claim.text}</p>
            <p className="mt-2 text-sm leading-relaxed text-graphite/75">{claim.warrant}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function ScorecardBars({ scorecard }: { scorecard: Scorecard }) {
  return (
    <div className="space-y-4">
      {scorecard.categories.map((category) => (
        <div key={category.name}>
          <div className="mb-1 flex items-center justify-between text-sm">
            <span className="font-semibold capitalize text-ink">{category.name}</span>
            <span className="text-graphite/60">
              {category.pro.toFixed(1)} / {category.con.toFixed(1)}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-1">
            <div className="h-2 rounded-full bg-linen">
              <div className="h-2 rounded-full bg-jade" style={{ width: `${Math.min(100, category.pro * 10)}%` }} />
            </div>
            <div className="h-2 rounded-full bg-linen">
              <div className="h-2 rounded-full bg-coral" style={{ width: `${Math.min(100, category.con * 10)}%` }} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function SourceCard({ source }: { source: EvidenceSource }) {
  return (
    <article className="rounded-lg border border-graphite/15 bg-white p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-linen px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-graphite/70">
          {source.quality}
        </span>
        <span className="rounded-full bg-jade/10 px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-jade">
          {source.retrievedVia}
        </span>
        <span className="rounded-full bg-white px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-graphite/60">
          {source.status}
        </span>
      </div>
      <a href={source.url} target="_blank" rel="noreferrer" className="text-base font-semibold text-ink hover:text-jade">
        {source.title}
      </a>
      <div className="mt-1 text-sm font-semibold text-graphite/60">{source.publisher}</div>
      <p className="mt-2 text-sm leading-relaxed text-graphite/75">{source.snippet}</p>
    </article>
  );
}

function SideBadge({ side }: { side: "pro" | "con" | "neutral" }) {
  const className =
    side === "pro"
      ? "bg-jade/10 text-jade"
      : side === "con"
        ? "bg-coral/10 text-coral"
        : "bg-plum/10 text-plum";

  return <span className={`rounded-full px-2 py-1 text-xs font-semibold uppercase tracking-[0.08em] ${className}`}>{side}</span>;
}

function formatRound(round: DebateRound) {
  return round.replace("_", " ");
}

function formatRecommendation(recommendation: Scorecard["recommendation"]) {
  return recommendation.replace("_", " ");
}

function groupTurns(turns: RoundTurn[]) {
  return turns.reduce<Record<string, RoundTurn[]>>((groups, turn) => {
    groups[turn.round] = groups[turn.round] ?? [];
    groups[turn.round].push(turn);
    return groups;
  }, {});
}
