// AUTO-GENERATED FILE — do not edit by hand.
// Regenerated from apps/debatefrog-web/public/sounds/ by
// scripts/generate-audio-manifest.mjs on every predev / prebuild.
// See use-frog-sounds.ts for how this is consumed.

export type AudioFormat = "wav" | "ogg" | "mp3";

export type AudioEntry =
  | { exists: true; hash: string }
  | { exists: false };

export interface AudioClip {
  /** Stable file-id like 'frog1', 'frog2', ... */
  id: string;
  /** Per-format presence + content hash. */
  formats: Record<AudioFormat, AudioEntry>;
}

/**
 * Shared pool of frog clips. Both pro and con frogs draw from this
 * pool — there is no per-side audio. The hook picks a random clip
 * when each frog starts speaking, avoiding the clip currently
 * playing on the other side.
 */
export const audioClips: readonly AudioClip[] = [] as const;
