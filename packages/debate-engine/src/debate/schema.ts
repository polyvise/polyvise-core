import { z } from "zod";

const modelSlotSchema = z
  .string()
  .trim()
  .min(1, "Model id cannot be empty.")
  .max(120, "Model id is unusually long.")
  .optional();

export const debateModelSelectionSchema = z
  .object({
    yes: modelSlotSchema,
    no: modelSlotSchema,
    quick: modelSlotSchema,
    deep: modelSlotSchema,
    judge: modelSlotSchema
  })
  .partial()
  .optional();

export const debateRequestSchema = z.object({
  subject: z
    .string()
    .trim()
    .min(4, "Enter at least a short subject.")
    .max(600, "Keep the subject under 600 characters."),
  context: z.string().trim().max(1600, "Keep context under 1600 characters.").optional(),
  mode: z.literal("hybrid_council").default("hybrid_council"),
  evidence: z.literal("cited").default("cited"),
  models: debateModelSelectionSchema,
  // Defaults to "quartet" so legacy callers keep the canonical 2+2+judge
  // shape. The /froglings UI sends "duo" for a 1-on-1 debate.
  councilSize: z.enum(["duo", "quartet"]).default("quartet"),
  devOptions: z
    .object({
      liveApis: z.boolean().optional()
    })
    .partial()
    .optional()
});

export const followupRequestSchema = z.object({
  question: z.string().trim().min(4).max(700)
});

export const feedbackRequestSchema = z.object({
  message: z.string().trim().min(1, "Feedback cannot be empty.").max(2000, "Keep feedback under 2000 characters."),
  debateId: z.string().trim().max(80).optional(),
  pagePath: z.string().trim().max(500).optional()
});

const perspectiveSideSchema = z.enum(["pro", "con", "neutral"]);

export const stanceScoutOutputSchema = z.object({
  name: z.string().min(1),
  model: z.string().min(1),
  lens: z.string().min(1),
  side: perspectiveSideSchema,
  thesis: z.string().min(1),
  assumptions: z.array(z.string().min(1)).min(1),
  strongestArguments: z.array(z.string().min(1)).min(1)
});

export const scoutOutputSchema = z.object({
  scouts: z.array(stanceScoutOutputSchema).min(3)
});

export const claimOutputSchema = z.object({
  claims: z
    .array(
      z.object({
        side: perspectiveSideSchema,
        text: z.string().min(1),
        warrant: z.string().min(1),
        evidenceSourceIds: z.array(z.string()).default([]),
        confidence: z.number().min(0).max(1)
      })
    )
    .min(2)
});

export const debateTurnOutputSchema = z.object({
  turns: z
    .array(
      z.object({
        round: z.enum(["opening", "cross_examination", "rebuttal", "closing", "judge_review", "synthesis"]),
        agentId: z.string().min(1),
        agentName: z.string().min(1),
        side: perspectiveSideSchema,
        content: z.string().min(1),
        claimIds: z.array(z.string()).default([]),
        sourceIds: z.array(z.string()).default([])
      })
    )
    .min(1)
});

export const judgeScorecardOutputSchema = z.object({
  recommendation: z.enum(["conditional_yes", "lean_yes", "mixed", "lean_no", "conditional_no"]),
  confidence: z.number().min(0).max(1),
  categories: z
    .array(
      z.object({
        name: z.enum(["evidence", "practicality", "risk", "fairness", "reversibility"]),
        pro: z.number().min(0).max(10),
        con: z.number().min(0).max(10),
        note: z.string().min(1)
      })
    )
    .min(1)
});

export const finalSummaryOutputSchema = z.object({
  headline: z.string().min(1),
  recommendation: z.string().min(1),
  strongestPro: z.array(z.string().min(1)).default([]),
  strongestCon: z.array(z.string().min(1)).default([]),
  unresolvedUncertainties: z.array(z.string().min(1)).default([]),
  whatWouldChangeMind: z.array(z.string().min(1)).default([]),
  confidence: z.number().min(0).max(100).optional(),
  highStakesDisclaimer: z.string().nullable().optional()
});

export const followupOutputSchema = z.object({
  answer: z.string().min(1)
});
