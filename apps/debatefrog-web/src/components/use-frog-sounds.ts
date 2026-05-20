"use client";

/**
 * useFrogSounds — owns Web Audio for the /froglings funner experience.
 *
 * Audio model: pro/con frogs randomly pick from a shared pool when
 * speaking, while the judge prefers frog5 when it is present. Frog roles
 * still matter for gain/ducking/muting.
 *
 * Design goals:
 *  - Browsers block audio until the first user gesture. The hook
 *    exposes an `unlock()` function which the caller fires on the
 *    user's first real interaction (the "Start the debate!" button).
 *  - Mute state is persisted to localStorage so a parent/teacher can
 *    silence it once and have it stick across navigations and reloads.
 *  - Real files at /sounds/frog<N>.{wav,ogg,mp3} are preferred. The
 *    loader picks the best format the browser can play for each clip
 *    in this order: wav (universal), ogg (smaller, evergreen browsers
 *    + Safari 18+), mp3 (universal fallback). If no real clips are
 *    present, the hook drops to a procedural Web Audio synth so the
 *    page is never silent. See public/sounds/CREDITS.md.
 *  - Each real-file fetch carries `?v=<content-hash>` from the
 *    build-time audio-manifest, so swapping a clip auto-busts the
 *    browser cache without manual versioning.
 *  - `play(side)` picks a clip (preferring one that isn't currently
 *    active on another channel), starts it on that role's gain channel,
 *    and ducks it on `stop(side)`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  audioClips,
  type AudioClip,
  type AudioFormat
} from "@/lib/audio-manifest";

type Side = "pro" | "con" | "judge";

const MUTE_STORAGE_KEY = "froglings:muted";

// WAV first because (a) it's what the user is most likely to drop in
// and (b) it decodes natively in every browser with no codec questions.
// OGG next because it's smaller for users who do transcode. MP3 last as
// a universal fallback for the handful of edge cases.
const FORMAT_PRIORITY: AudioFormat[] = ["wav", "ogg", "mp3"];
const MIME_FOR_FORMAT: Record<AudioFormat, string> = {
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp3: "audio/mpeg"
};

/**
 * Picks the best playable URL for a clip, or null if none of its
 * formats exist or the browser can't decode any of them.
 */
function pickSourceUrl(clip: AudioClip): string | null {
  if (typeof window === "undefined") return null;
  const probe = document.createElement("audio");
  for (const fmt of FORMAT_PRIORITY) {
    const entry = clip.formats[fmt];
    if (!entry.exists) continue;
    const support = probe.canPlayType(MIME_FOR_FORMAT[fmt]);
    // canPlayType returns "" / "maybe" / "probably". Accept anything
    // non-empty so older Safari (which only ever returns "maybe" for
    // Ogg) still works.
    if (support === "") continue;
    return `/sounds/${clip.id}.${fmt}?v=${entry.hash}`;
  }
  return null;
}

interface LoadedClip {
  id: string;
  buffer: AudioBuffer;
}

interface SideChannel {
  /** Per-side gain node so each side fades / mutes independently. */
  gain: GainNode;
  /** Active source for cleanup; null when not playing. */
  source: AudioBufferSourceNode | OscillatorNode | null;
  /** Id of the clip currently playing, for cross-side de-duplication. */
  currentClipId: string | null;
}

interface FrogSoundsApi {
  /** True once the AudioContext has been resumed by a user gesture. */
  ready: boolean;
  /** True when the user has muted; persisted to localStorage. */
  muted: boolean;
  /** Toggle mute and persist the new state. */
  toggleMute: () => void;
  /** Resume the AudioContext. Safe to call multiple times. */
  unlock: () => Promise<void>;
  /** Start a loop for a side. No-op if muted or not unlocked. */
  play: (side: Side, options?: { random?: boolean }) => void;
  /** Fade and stop the loop for a side. */
  stop: (side: Side) => void;
}

export function useFrogSounds(): FrogSoundsApi {
  const ctxRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const channelsRef = useRef<Record<Side, SideChannel> | null>(null);
  /** All real clips successfully fetched + decoded. May be empty. */
  const poolRef = useRef<LoadedClip[]>([]);
  const [ready, setReady] = useState(false);
  const [muted, setMuted] = useState<boolean>(false);

  // Hydrate persisted mute setting once on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = window.localStorage.getItem(MUTE_STORAGE_KEY);
      if (stored === "1") setMuted(true);
    } catch {
      // localStorage may be disabled (private mode, etc.); fail open.
    }
  }, []);

  // When mute toggles, immediately reflect that on the master gain
  // node if the context is already live.
  useEffect(() => {
    const master = masterGainRef.current;
    const ctx = ctxRef.current;
    if (!master || !ctx) return;
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.linearRampToValueAtTime(muted ? 0 : 1, ctx.currentTime + 0.08);
  }, [muted]);

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      try {
        if (typeof window !== "undefined") {
          window.localStorage.setItem(MUTE_STORAGE_KEY, next ? "1" : "0");
        }
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const unlock = useCallback(async () => {
    if (typeof window === "undefined") return;
    if (ctxRef.current) {
      if (ctxRef.current.state === "suspended") {
        await ctxRef.current.resume();
      }
      setReady(true);
      return;
    }

    const AudioCtor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return;
    const ctx = new AudioCtor();
    ctxRef.current = ctx;

    // Master gain — gates the whole hook for mute.
    const master = ctx.createGain();
    master.gain.value = muted ? 0 : 1;
    master.connect(ctx.destination);
    masterGainRef.current = master;

    // Per-side channels. Sides share the clip pool but each have their
    // own gain so fades / mutes / ducking are independent.
    const makeChannel = (): SideChannel => {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(master);
      return { gain, source: null, currentClipId: null };
    };
    channelsRef.current = { pro: makeChannel(), con: makeChannel(), judge: makeChannel() };

    // Fetch + decode every clip in parallel. Any that 404 or fail to
    // decode are silently skipped; if the whole pool ends up empty,
    // play() falls through to the synth.
    const pool: LoadedClip[] = (
      await Promise.all(
        audioClips.map(async (clip): Promise<LoadedClip | null> => {
          const url = pickSourceUrl(clip);
          if (!url) return null;
          try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const bytes = await response.arrayBuffer();
            const buffer = await ctx.decodeAudioData(bytes.slice(0));
            return { id: clip.id, buffer };
          } catch {
            return null;
          }
        })
      )
    ).filter((entry): entry is LoadedClip => entry !== null);
    poolRef.current = pool;

    if (ctx.state === "suspended") await ctx.resume();
    setReady(true);
  }, [muted]);

  const stop = useCallback((side: Side) => {
    const ctx = ctxRef.current;
    const channels = channelsRef.current;
    if (!ctx || !channels) return;
    const ch = channels[side];
    ch.gain.gain.cancelScheduledValues(ctx.currentTime);
    ch.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.12);
    if (ch.source) {
      const src = ch.source;
      try {
        src.stop(ctx.currentTime + 0.14);
      } catch {
        // already stopped
      }
      src.onended = () => {
        try {
          src.disconnect();
        } catch {
          // ignore
        }
      };
      ch.source = null;
    }
    ch.currentClipId = null;
  }, []);

  const play = useCallback(
    (side: Side, options?: { random?: boolean }) => {
      const ctx = ctxRef.current;
      const channels = channelsRef.current;
      const master = masterGainRef.current;
      if (!ctx || !channels || !master) return;
      if (muted) return;

      // Stop any previous source for this side to avoid overlap.
      stop(side);

      const ch = channels[side];
      const activeOtherClipIds = new Set(
        Object.entries(channels)
          .filter(([channelSide]) => channelSide !== side)
          .map(([, channel]) => channel.currentClipId)
          .filter((clipId): clipId is string => Boolean(clipId))
      );
      const targetGain = 0.36;
      const pool = poolRef.current;

      if (pool.length > 0) {
        // The judge gets the user's dedicated clip when available,
        // except for explicit random one-off cues. The speaking frogs
        // rotate through the rest of the pool, so frog5 stays
        // recognizably tied to the verdict moment.
        const judgeClip = pool.find((clip) => clip.id === "frog5");
        const rolePool = options?.random || side === "judge" || !judgeClip
          ? pool
          : pool.filter((clip) => clip.id !== judgeClip.id);
        const candidates = rolePool.filter((clip) => !activeOtherClipIds.has(clip.id));
        const choice =
          side === "judge" && judgeClip && !options?.random
            ? judgeClip
            : candidates.length > 0
              ? candidates[Math.floor(Math.random() * candidates.length)]
              : rolePool[Math.floor(Math.random() * rolePool.length)];

        const src = ctx.createBufferSource();
        src.buffer = choice.buffer;
        src.loop = true;
        // Tiny random pitch jitter (~±3 semitones in playbackRate
        // terms) so successive plays of the same clip don't feel
        // identical. Keeps each side recognizably "frog" but with
        // organic variation.
        const jitter = 0.92 + Math.random() * 0.16; // 0.92 – 1.08
        src.playbackRate.value = jitter;
        src.connect(ch.gain);
        ch.gain.gain.cancelScheduledValues(ctx.currentTime);
        ch.gain.gain.setValueAtTime(0, ctx.currentTime);
        ch.gain.gain.linearRampToValueAtTime(targetGain, ctx.currentTime + 0.12);
        src.start();
        ch.source = src;
        ch.currentClipId = choice.id;
        return;
      }

      // Synth fallback — no real clips were loaded. Single oscillator +
      // vibrato + tremolo, with a slight tone difference per frog so
      // simultaneous speaking still distinguishes them by ear.
      const osc = ctx.createOscillator();
      osc.type = side === "con" ? "sawtooth" : "triangle";
      const baseHz = side === "pro" ? 520 : side === "con" ? 110 : 260;
      osc.frequency.value = baseHz;

      const lfo = ctx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = side === "pro" ? 9 : side === "con" ? 5.5 : 7;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = side === "pro" ? 32 : side === "con" ? 14 : 22;
      lfo.connect(lfoGain).connect(osc.frequency);
      lfo.start();

      const tremolo = ctx.createOscillator();
      tremolo.type = "sine";
      tremolo.frequency.value = side === "pro" ? 6.5 : side === "con" ? 3.2 : 4.8;
      const tremoloGain = ctx.createGain();
      tremoloGain.gain.value = 0.55;
      tremolo.connect(tremoloGain).connect(ch.gain.gain);
      tremolo.start();

      osc.connect(ch.gain);
      ch.gain.gain.cancelScheduledValues(ctx.currentTime);
      ch.gain.gain.setValueAtTime(0, ctx.currentTime);
      ch.gain.gain.linearRampToValueAtTime(targetGain, ctx.currentTime + 0.12);
      osc.start();
      ch.source = osc;
      ch.currentClipId = `synth:${side}`;
      osc.onended = () => {
        try {
          lfo.stop();
          tremolo.stop();
        } catch {
          // already stopped
        }
      };
    },
    [muted, stop]
  );

  // Clean up on unmount: close the context so we don't leak nodes.
  useEffect(() => {
    return () => {
      const ctx = ctxRef.current;
      if (!ctx) return;
      try {
        ctx.close();
      } catch {
        // already closed
      }
      ctxRef.current = null;
      channelsRef.current = null;
      masterGainRef.current = null;
      poolRef.current = [];
    };
  }, []);

  return { ready, muted, toggleMute, unlock, play, stop };
}
