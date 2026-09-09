import { z } from "zod";

/**
 * Structured-output contracts for the advisory panel.
 *
 * The panel is additive rather than adversarial: each lens advises without
 * seeing the others, and the chair reports where they line up and where they
 * genuinely conflict. Nothing here asks a lens to rebut another — a conflict
 * is a finding, not a debate to be won.
 */

const lensIdSchema = z.enum(["economist", "ethicist", "operator", "skeptic"]);

export const panelAdviceOutputSchema = z.object({
  recommendation: z.string().min(1).max(400),
  reasoning: z.string().min(1),
  keyRisks: z.array(z.string().min(1)).default([]),
  conditions: z.array(z.string().min(1)).default([]),
  confidence: z.number().min(0).max(1),
  sourceIds: z.array(z.string()).default([])
});

export const panelChairOutputSchema = z.object({
  headline: z.string().min(1).max(120),
  throughLine: z.string().min(1).max(400),
  /**
   * Only points at least two lenses actually made. A one-lens "agreement" is a
   * single opinion, and reporting it as consensus is the failure mode this
   * mode exists to avoid.
   */
  agreements: z
    .array(
      z.object({
        point: z.string().min(1),
        lensIds: z.array(lensIdSchema).min(2)
      })
    )
    .default([]),
  conflicts: z
    .array(
      z.object({
        point: z.string().min(1),
        positions: z
          .array(
            z.object({
              lensId: lensIdSchema,
              stance: z.string().min(1)
            })
          )
          .min(2)
      })
    )
    .default([]),
  decisionGuidance: z.string().min(1).max(700),
  confidence: z.number().min(0).max(100).optional(),
  highStakesDisclaimer: z.string().nullable().optional()
});
