import { z } from "zod";

export const debateRequestSchema = z.object({
  subject: z
    .string()
    .trim()
    .min(4, "Enter at least a short subject.")
    .max(600, "Keep the subject under 600 characters."),
  context: z.string().trim().max(1600, "Keep context under 1600 characters.").optional(),
  mode: z.literal("hybrid_council").default("hybrid_council"),
  evidence: z.literal("cited").default("cited")
});

export const followupRequestSchema = z.object({
  question: z.string().trim().min(4).max(700)
});
