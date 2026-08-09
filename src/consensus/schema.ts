import { z } from "zod";

/**
 * Structured-output contracts for the consensus mode.
 *
 * Note what is absent: nothing here asks a model how much the panel agrees.
 * Spread and convergence are computed from the positions in the engine, so a
 * model cannot flatter the result by declaring agreement it did not produce.
 */

export const consensusAgentOutputSchema = z.object({
  name: z.string().min(1),
  lens: z.string().min(1)
});

export const consensusPanelOutputSchema = z.object({
  agents: z.array(consensusAgentOutputSchema).min(3)
});

const stanceSchema = z.enum(["strongly_agree", "agree", "neutral", "disagree", "strongly_disagree"]);

/**
 * Used for both the independent opening round and every revision round. There
 * is no separate revision schema on purpose: whether an agent moved is decided
 * by comparing its stance to the previous round, not by asking it.
 */
export const consensusPositionOutputSchema = z.object({
  positions: z
    .array(
      z.object({
        agentId: z.string().min(1),
        agentName: z.string().min(1),
        stance: stanceSchema,
        answer: z.string().min(1),
        rationale: z.string().min(1),
        confidence: z.number().min(0).max(1),
        sourceIds: z.array(z.string()).default([])
      })
    )
    .min(1)
});

export const consensusSummaryOutputSchema = z.object({
  headline: z.string().min(1).max(120),
  finding: z.string().min(1).max(400),
  finalAnswer: z.string().min(1).max(400),
  range: z.string().min(1).max(400),
  agreed: z.array(z.string().min(1)).default([]),
  contested: z.array(z.string().min(1)).default([]),
  unresolvedUncertainties: z.array(z.string().min(1)).default([]),
  /**
   * Why each dissenting agent stayed outside the majority. Which agents are
   * dissenters is decided by the engine from their stances; this only supplies
   * the reasoning, and entries for agents that agreed are discarded.
   */
  holdoutReasons: z
    .array(
      z.object({
        agentId: z.string().min(1),
        reason: z.string().min(1)
      })
    )
    .default([]),
  confidence: z.number().min(0).max(100).optional(),
  highStakesDisclaimer: z.string().nullable().optional()
});
