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
 * Frog clips discovered from public/sounds/. YES and NO frogs draw
 * randomly from the shared pool, while the judge prefers frog5 when
 * it is present.
 */
export const audioClips: readonly AudioClip[] = [
  {
    "id": "frog1",
    "formats": {
      "wav": {
        "exists": true,
        "hash": "fb3092ef80"
      },
      "ogg": {
        "exists": false
      },
      "mp3": {
        "exists": false
      }
    }
  },
  {
    "id": "frog2",
    "formats": {
      "wav": {
        "exists": true,
        "hash": "480dac40aa"
      },
      "ogg": {
        "exists": false
      },
      "mp3": {
        "exists": false
      }
    }
  },
  {
    "id": "frog3",
    "formats": {
      "wav": {
        "exists": true,
        "hash": "280d636e04"
      },
      "ogg": {
        "exists": false
      },
      "mp3": {
        "exists": false
      }
    }
  },
  {
    "id": "frog4",
    "formats": {
      "wav": {
        "exists": true,
        "hash": "27254e3b8c"
      },
      "ogg": {
        "exists": false
      },
      "mp3": {
        "exists": false
      }
    }
  },
  {
    "id": "frog5",
    "formats": {
      "wav": {
        "exists": true,
        "hash": "06e86bed04"
      },
      "ogg": {
        "exists": false
      },
      "mp3": {
        "exists": false
      }
    }
  }
] as const;
