// AUTO-GENERATED FILE — do not edit by hand.
// Regenerated from apps/debatefrog-web/public/sounds/ by
// scripts/generate-audio-manifest.mjs on every predev / prebuild.
// See use-frog-sounds.ts for how this is consumed.

export type AudioFormat = "mp3" | "ogg";

export type AudioEntry =
  | { exists: true; hash: string }
  | { exists: false };

export type AudioSide = "pro" | "con";

export const audioFileNames: Record<AudioSide, string> = {
  pro: "pro-chirp",
  con: "con-croak"
};

export const audioManifest: Record<AudioSide, Record<AudioFormat, AudioEntry>> = {
  "pro": {
    "mp3": {
      "exists": false
    },
    "ogg": {
      "exists": false
    }
  },
  "con": {
    "mp3": {
      "exists": false
    },
    "ogg": {
      "exists": false
    }
  }
} as const;
