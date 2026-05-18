"use client";

/**
 * FroglingsIntro — a small four-slide explainer that runs once per
 * browser session (gated by sessionStorage) before a kid sees the
 * question form. It teaches the basic shape of a debate so the
 * subsequent live view actually means something.
 *
 * The "Show intro again" link in FroglingsWorkspace's footer lets a kid
 * re-open it manually after they've dismissed it.
 */

import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { FunFrog } from "@/components/fun-frog";

interface FroglingsIntroProps {
  onDismiss: () => void;
}

type Slide = {
  title: string;
  body: React.ReactNode;
};

export function FroglingsIntro({ onDismiss }: FroglingsIntroProps) {
  const [step, setStep] = useState(0);

  const slides: Slide[] = [
    {
      title: "What's a debate?",
      body: (
        <div className="space-y-3">
          <p className="text-base leading-relaxed text-ink/85">
            A <strong>debate</strong> is like a friendly game where two sides argue different
            answers to a big question.
          </p>
          <p className="text-base leading-relaxed text-ink/85">
            One side says <strong className="text-pond">YES</strong> and tries to prove they're
            right. The other side says <strong className="text-berry">NO</strong> and tries to
            prove they're right. A judge listens to both sides and picks the better case.
          </p>
        </div>
      )
    },
    {
      title: "Meet the frogs",
      body: (
        <div className="space-y-4">
          <p className="text-base leading-relaxed text-ink/85">
            On this page, three frogs do all the talking:
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="flex flex-col items-center rounded-2xl border border-leaf/30 bg-mint/40 p-3 text-center">
              <FunFrog mood="pro" size={56} />
              <div className="mt-1 text-[11px] font-black uppercase tracking-wide text-pond">
                Pro frog
              </div>
              <div className="text-xs text-ink/70">Says YES to the question.</div>
            </div>
            <div className="flex flex-col items-center rounded-2xl border border-berry/30 bg-lily/40 p-3 text-center">
              <FunFrog mood="con" size={56} />
              <div className="mt-1 text-[11px] font-black uppercase tracking-wide text-berry">
                Con frog
              </div>
              <div className="text-xs text-ink/70">Says NO to the question.</div>
            </div>
            <div className="flex flex-col items-center rounded-2xl border border-[#9978b8]/30 bg-[#ece4f5]/60 p-3 text-center">
              <FunFrog mood="judge" size={56} />
              <div className="mt-1 text-[11px] font-black uppercase tracking-wide text-[#5c4583]">
                Judge frog
              </div>
              <div className="text-xs text-ink/70">Picks who made the better case.</div>
            </div>
          </div>
        </div>
      )
    },
    {
      title: "Four rounds",
      body: (
        <div className="space-y-3">
          <p className="text-base leading-relaxed text-ink/85">
            The two frogs take turns talking in four rounds. Each round has its own job:
          </p>
          <ol className="space-y-2 text-sm leading-relaxed text-ink/85">
            <li className="rounded-xl border border-mud/15 bg-cream/40 p-3">
              <span className="font-black text-pond">1. Opening.</span> Each frog says what they
              think.
            </li>
            <li className="rounded-xl border border-mud/15 bg-cream/40 p-3">
              <span className="font-black text-pond">2. Tough questions.</span> Each frog asks the
              other one tricky questions.
            </li>
            <li className="rounded-xl border border-mud/15 bg-cream/40 p-3">
              <span className="font-black text-pond">3. Comeback.</span> Each frog answers back to
              defend their side.
            </li>
            <li className="rounded-xl border border-mud/15 bg-cream/40 p-3">
              <span className="font-black text-pond">4. Last word.</span> Each frog says why they
              should win.
            </li>
          </ol>
        </div>
      )
    },
    {
      title: "Then the judge decides!",
      body: (
        <div className="space-y-3">
          <p className="text-base leading-relaxed text-ink/85">
            After all four rounds the judge frog thinks really hard and tells you which side made
            the better case.
          </p>
          <p className="text-base leading-relaxed text-ink/85">
            The judge also tells you <strong>how sure</strong> they are. Sometimes the answer is
            close! Sometimes one frog clearly wins.
          </p>
          <p className="text-base leading-relaxed text-pond">
            Ready? Pick a question and start the debate. <span aria-hidden="true">🐸</span>
          </p>
        </div>
      )
    }
  ];

  const isLast = step === slides.length - 1;
  const current = slides[step];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-4 py-6 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="froglings-intro-title"
        className="hop-in w-full max-w-xl rounded-3xl border border-mud/20 bg-panel/98 p-6 shadow-lily sm:p-8"
      >
        <header className="flex items-start justify-between gap-3">
          <h2
            id="froglings-intro-title"
            className="text-2xl font-black leading-snug text-pond"
          >
            {current.title}
          </h2>
          <button
            type="button"
            onClick={onDismiss}
            className="text-xs font-semibold text-pond/60 transition hover:text-pond"
          >
            Skip intro
          </button>
        </header>

        <div className="mt-4 min-h-[12rem]">{current.body}</div>

        <footer className="mt-6 flex items-center justify-between">
          <div className="flex items-center gap-1.5" aria-hidden="true">
            {slides.map((_, idx) => (
              <span
                key={idx}
                className={`h-1.5 w-6 rounded-full transition ${
                  idx === step ? "bg-pond" : idx < step ? "bg-pond/40" : "bg-mud/15"
                }`}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              if (isLast) onDismiss();
              else setStep((s) => s + 1);
            }}
            className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-br from-pond to-leafDark px-4 py-2 text-sm font-black text-white shadow-lily transition hover:opacity-95"
          >
            {isLast ? "Got it! Let's go" : "Next"}
            <ArrowRight className="h-4 w-4" />
          </button>
        </footer>
      </div>
    </div>
  );
}
