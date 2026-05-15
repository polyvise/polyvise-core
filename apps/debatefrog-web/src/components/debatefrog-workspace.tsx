"use client";

import { FormEvent, useState } from "react";
import type { DebateRecord } from "@polyvise/debate-engine/debate/types";

const prompts = [
  "Should every meeting need a written reason to exist?",
  "Should a startup hire generalists before specialists?",
  "Should schools ban phones during the day?"
];

export function DebatefrogWorkspace() {
  const [subject, setSubject] = useState(prompts[0]);
  const [context, setContext] = useState("");
  const [debate, setDebate] = useState<DebateRecord | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runDebate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsLoading(true);
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
        throw new Error(payload.error ?? "Unable to run the debate.");
      }

      setDebate(payload.debate);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to run the debate.");
    } finally {
      setIsLoading(false);
    }
  }

  const run = debate?.latestRun;

  return (
    <main className="shell">
      <section className="hero">
        <div className="brandRow">
          <span className="mark" aria-hidden="true" />
          <span className="brand">Debatefrog</span>
        </div>
        <div className="heroGrid">
          <div className="copy">
            <h1>Drop a question in the pond.</h1>
            <p>
              Debatefrog uses the Polyvise engine to stage a fast, cited council debate with a friendlier public face.
            </p>
          </div>

          <form className="debateForm" onSubmit={runDebate}>
            <label htmlFor="subject">Question</label>
            <textarea id="subject" value={subject} onChange={(event) => setSubject(event.target.value)} />

            <label htmlFor="context">Optional context</label>
            <textarea
              id="context"
              value={context}
              onChange={(event) => setContext(event.target.value)}
              placeholder="Audience, constraints, stakes, or what sparked the question."
            />

            {error ? <div className="error">{error}</div> : null}

            <button type="submit" disabled={isLoading || subject.trim().length < 4}>
              {isLoading ? "Summoning the council..." : "Start the debate"}
            </button>
          </form>
        </div>
      </section>

      <section className="promptRow" aria-label="Example prompts">
        {prompts.map((prompt) => (
          <button key={prompt} type="button" onClick={() => setSubject(prompt)}>
            {prompt}
          </button>
        ))}
      </section>

      {run ? (
        <section className="results">
          <div className="summary">
            <span className="eyebrow">Council verdict</span>
            <h2>{run.summary.headline}</h2>
            <p>{run.summary.recommendation}</p>
          </div>

          <div className="columns">
            <div>
              <h3>Best yes case</h3>
              <ul>
                {run.summary.strongestPro.slice(0, 3).map((claim) => (
                  <li key={claim}>{claim}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3>Best no case</h3>
              <ul>
                {run.summary.strongestCon.slice(0, 3).map((claim) => (
                  <li key={claim}>{claim}</li>
                ))}
              </ul>
            </div>
          </div>

          <div className="sources">
            <h3>First sources</h3>
            <div>
              {run.sources.slice(0, 4).map((source) => (
                <a key={source.id} href={source.url} target="_blank" rel="noreferrer">
                  {source.publisher}
                </a>
              ))}
            </div>
          </div>
        </section>
      ) : null}
    </main>
  );
}
