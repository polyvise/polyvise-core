import { describe, expect, it } from "vitest";
import {
  createDailyPublishManifest,
  dailyPublishManifestSchema,
  defaultDailyArtifacts
} from "@/lib/publishing/manifest";

describe("daily publish manifest", () => {
  it("creates a portable manifest for local batch uploads", () => {
    const manifest = createDailyPublishManifest({
      runDate: "2026-05-15",
      generatedAt: "2026-05-15T08:00:00.000Z",
      provider: "cloudflare",
      environment: "staging",
      artifacts: defaultDailyArtifacts("2026-05-15")
    });

    expect(manifest.currentPointer).toBe("daily/2026-05-15/manifest.json");
    expect(manifest.artifacts.map((artifact) => artifact.kind)).toEqual([
      "manifest",
      "full_state",
      "summary",
      "report"
    ]);
    expect(dailyPublishManifestSchema.parse(manifest)).toEqual(manifest);
  });

  it("rejects invalid run dates and checksums", () => {
    expect(() =>
      createDailyPublishManifest({
        runDate: "05/15/2026",
        provider: "google_cloud",
        artifacts: defaultDailyArtifacts("2026-05-15")
      })
    ).toThrow();

    expect(
      dailyPublishManifestSchema.safeParse({
        schemaVersion: 1,
        runDate: "2026-05-15",
        generatedAt: "2026-05-15T08:00:00.000Z",
        provider: "google_cloud",
        environment: "production",
        status: "complete",
        currentPointer: "daily/2026-05-15/manifest.json",
        artifacts: [
          {
            kind: "summary",
            path: "daily/2026-05-15/summary.json",
            contentType: "application/json",
            sha256: "not-a-checksum"
          }
        ]
      }).success
    ).toBe(false);
  });
});
