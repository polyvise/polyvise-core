import { runConsensus, type ConsensusExecutionOptions } from "../consensus/engine";
import { frameDebateRequest, runHybridCouncilDebate, type FramedDebate } from "../debate/engine";
import { runAdvisoryPanel, type AdvisoryPanelExecutionOptions } from "../panel/engine";
import type { DebateRequest, DebateRun } from "../debate/types";
import type { DebateExecutionOptions } from "../debate/engine";
import type { DebateRunEnvelope, HybridCouncilResult, RunEnvelope } from "./types";

/**
 * Options accepted by `runDeliberation`. Each mode's emitter differs, so the
 * per-mode option objects stay separate rather than being merged into one
 * loosely-typed bag.
 */
export interface DeliberationOptions {
  hybridCouncil?: DebateExecutionOptions;
  consensus?: ConsensusExecutionOptions;
  advisoryPanel?: AdvisoryPanelExecutionOptions;
}

/**
 * Runs whichever mode the request asks for and returns it in the shared
 * envelope.
 *
 * Callers that need a mode's specific payload should narrow on
 * `run.result.mode` (or use the `is*Run` guards) rather than reaching for
 * fields that only one mode has.
 */
export async function runDeliberation(
  debateId: string,
  request: DebateRequest,
  framed: FramedDebate = frameDebateRequest(request),
  options: DeliberationOptions = {}
): Promise<RunEnvelope> {
  switch (request.mode ?? "hybrid_council") {
    case "consensus":
      return runConsensus(debateId, request, framed, options.consensus);
    case "advisory_panel":
      return runAdvisoryPanel(debateId, request, framed, options.advisoryPanel);
    case "hybrid_council":
    default: {
      const run = await runHybridCouncilDebate(debateId, request, framed, options.hybridCouncil);
      return toRunEnvelope(run);
    }
  }
}

/**
 * Views an existing `DebateRun` through the shared envelope.
 *
 * The debate engine still assembles the flat `DebateRun` it always has — that
 * path is covered by a large test suite and there was no reason to rewrite it
 * to gain a shape this conversion produces losslessly. Everything the envelope
 * carries is already on `DebateRun`; this only sorts those fields into the
 * mode-independent half and the hybrid-council half.
 */
export function toRunEnvelope(run: DebateRun): DebateRunEnvelope {
  const result: HybridCouncilResult = {
    mode: "hybrid_council",
    scouts: run.scouts,
    teams: run.teams,
    claims: run.claims,
    argumentNodes: run.argumentNodes,
    argumentEdges: run.argumentEdges,
    turns: run.turns,
    scorecard: run.scorecard,
    summary: run.summary,
    ...(run.councilSize ? { councilSize: run.councilSize } : {})
  };

  return {
    id: run.id,
    debateId: run.debateId,
    status: run.status,
    startedAt: run.startedAt,
    events: run.events,
    sources: run.sources,
    modelSnapshots: run.modelSnapshots,
    artifactManifest: run.artifactManifest,
    trace: run.trace,
    result,
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    ...(run.placeholders ? { placeholders: run.placeholders } : {})
  };
}

/** The inverse of `toRunEnvelope`, for callers still on the flat shape. */
export function toDebateRun(envelope: DebateRunEnvelope): DebateRun {
  const { result } = envelope;

  return {
    id: envelope.id,
    debateId: envelope.debateId,
    status: envelope.status,
    startedAt: envelope.startedAt,
    events: envelope.events,
    scouts: result.scouts,
    teams: result.teams,
    sources: envelope.sources,
    claims: result.claims,
    argumentNodes: result.argumentNodes,
    argumentEdges: result.argumentEdges,
    turns: result.turns,
    scorecard: result.scorecard,
    summary: result.summary,
    modelSnapshots: envelope.modelSnapshots,
    artifactManifest: envelope.artifactManifest,
    trace: envelope.trace,
    ...(result.councilSize ? { councilSize: result.councilSize } : {}),
    ...(envelope.completedAt ? { completedAt: envelope.completedAt } : {}),
    ...(envelope.placeholders ? { placeholders: envelope.placeholders } : {})
  };
}
