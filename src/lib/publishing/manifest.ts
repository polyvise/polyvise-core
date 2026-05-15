import { z } from "zod";

export const publishProviderSchema = z.enum(["google_cloud", "cloudflare", "hostinger", "other"]);

export const publishArtifactKindSchema = z.enum([
  "manifest",
  "full_state",
  "summary",
  "debates",
  "sources",
  "claims",
  "scorecards",
  "report"
]);

export const publishArtifactSchema = z.object({
  kind: publishArtifactKindSchema,
  path: z.string().min(1),
  contentType: z.string().min(1),
  bytes: z.number().int().nonnegative().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional()
});

export const dailyPublishManifestSchema = z.object({
  schemaVersion: z.literal(1),
  runDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  generatedAt: z.string().datetime(),
  provider: publishProviderSchema,
  environment: z.enum(["local", "staging", "production"]),
  status: z.enum(["complete", "partial", "failed"]),
  currentPointer: z.string().min(1),
  artifacts: z.array(publishArtifactSchema).min(1),
  notes: z.array(z.string()).default([])
});

export type PublishProvider = z.infer<typeof publishProviderSchema>;
export type PublishArtifact = z.infer<typeof publishArtifactSchema>;
export type DailyPublishManifest = z.infer<typeof dailyPublishManifestSchema>;

export function createDailyPublishManifest(input: {
  runDate: string;
  generatedAt?: string;
  provider: PublishProvider;
  environment?: DailyPublishManifest["environment"];
  status?: DailyPublishManifest["status"];
  basePath?: string;
  artifacts: PublishArtifact[];
  notes?: string[];
}): DailyPublishManifest {
  const basePath = input.basePath ?? `daily/${input.runDate}`;

  return dailyPublishManifestSchema.parse({
    schemaVersion: 1,
    runDate: input.runDate,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    provider: input.provider,
    environment: input.environment ?? "local",
    status: input.status ?? "complete",
    currentPointer: `${basePath}/manifest.json`,
    artifacts: input.artifacts,
    notes: input.notes ?? []
  });
}

export function defaultDailyArtifacts(runDate: string): PublishArtifact[] {
  const basePath = `daily/${runDate}`;

  return [
    {
      kind: "manifest",
      path: `${basePath}/manifest.json`,
      contentType: "application/json"
    },
    {
      kind: "full_state",
      path: `${basePath}/full-state.json`,
      contentType: "application/json"
    },
    {
      kind: "summary",
      path: `${basePath}/summary.json`,
      contentType: "application/json"
    },
    {
      kind: "report",
      path: `${basePath}/report.md`,
      contentType: "text/markdown"
    }
  ];
}
