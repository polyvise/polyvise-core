"use client";

/**
 * useFrogSounds — owns Web Audio for the /froglings funner experience.
 *
 * Design goals:
 *  - Browsers block audio until the first user gesture. The hook exposes
 *    an `unlock()` function which the caller fires on the user's first
 *    real interaction (the "Start the debate!" button click).
 *  - Mute state is persisted to localStorage so a parent/teacher can
 *    silence it once and have it stick across navigations and reloads.
 *  - Real CC0 files at /sounds/pro-chirp.{ogg,mp3} +
 *    /sounds/con-croak.{ogg,mp3} are preferred. .ogg is selected first
 *    when the browser reports support for it (smaller files, slightly
 *    higher quality at the same bitrate); .mp3 is the fallback for the
 *    handful of browsers that still don't decode .ogg cleanly. If
 *    neither is present, the hook drops to a procedural Web Audio synth
 *    so the page is never silent. See public/sounds/CREDITS.md.
 *  - Each real file is fetched with a `?v=<content-hash>` query
 *    parameter sourced from the build-time audio-manifest, so swapping
 *    a clip auto-busts the browser cache without manual versioning.
 *  - `play(side)` starts a softly-looping chirp/croak for that side and
 *    ducks any other side that's currently playing. `stop(side)` fades
 *    that side back to silence.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  audioFileNames,
  audioManifest,
  type AudioFormat,
  type AudioSide
} from "@/lib/audio-manifest";

type Side = AudioSide;

const MUTE_STORAGE_KEY = "froglings:muted";

const MIME_FOR_FORMAT: Record<AudioFormat, string> = {
  ogg: "audio/ogg",
  mp3: "audio/mpeg"
};

/**
 * Picks the best real-file URL for a side, or null if no real file
 * exists / the browser can't play any of them. Honors the build-time
 * manifest so we never 404 in steady state, and appends a content-hash
 * query string for automatic cache-busting.
 *
 * .ogg is tried before .mp3 because Ogg Vorbis is smaller at equivalent
 * quality and every evergreen browser plus Safari 18+ supports it.
 */
function pickSourceUrl(side: Side): string | null {
  if (typeof window === "undefined") return null;
  const audioProbe = document.createElement("audio");
  const formats: AudioFormat[] = ["ogg", "mp3"];
  for (const fmt of formats) {
    const entry = audioManifest[side][fmt];
    if (!entry.exists) continue;
    const support = audioProbe.canPlayType(MIME_FOR_FORMAT[fmt]);
    // canPlayType returns "" / "maybe" / "probably". We accept anything
    // non-empty so older Safari, which only ever returns "maybe" for
    // Ogg, still works.
    if (support === "") continue;
    return `/sounds/${audioFileNames[side]}.${fmt}?v=${entry.hash}`;
  }
  return null;
}

interface SideAudio {
  /** Decoded sample if a real file was loaded. */
  buffer: AudioBuffer | null;
  /** When the file failed to load we use the procedural synth instead. */
  useSynth: boolean;
  /** Per-side gain node so each side can fade independently. */
  gain: GainNode;
  /** Active source for cleanup; null when not playing. */
  source: AudioBufferSourceNode | OscillatorNode | null;
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
  /** Start the loop for a side. No-op if muted or not yet unlocked. */
  play: (side: Side) => void;
  /** Fade and stop the loop for a side. */
  stop: (side: Side) => void;
}

export function useFrogSounds(): FrogSoundsApi {
  const ctxRef = useRef<AudioContext | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const sidesRef = useRef<Record<Side, SideAudio> | null>(null);
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

  // When mute toggles, immediately reflect that on the master gain node
  // if the context is already live.
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
      // Already created — just make sure it's running.
      if (ctxRef.current.state === "suspended") {
        await ctxRef.current.resume();
      }
      setReady(true);
      return;
    }

    const AudioCtor: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return;
    const ctx = new AudioCtor();
    ctxRef.current = ctx;

    // Master gain controls mute state; per-side gains layer on top.
    const master = ctx.createGain();
    master.gain.value = muted ? 0 : 1;
    master.connect(ctx.destination);
    masterGainRef.current = master;

    // Try to fetch + decode each real file in parallel. Whichever ones
    // are absent from the manifest (or 404 / fail to decode for any
    // other reason) just flip useSynth=true for that side.
    const loadSide = async (side: Side): Promise<SideAudio> => {
      const sideGain = ctx.createGain();
      sideGain.gain.value = 0;
      sideGain.connect(master);

      const url = pickSourceUrl(side);
      if (!url) {
        // No real file the browser can play. Drop straight to synth.
        return { buffer: null, useSynth: true, gain: sideGain, source: null };
      }

      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = await response.arrayBuffer();
        const buffer = await ctx.decodeAudioData(bytes.slice(0));
        return { buffer, useSynth: false, gain: sideGain, source: null };
      } catch {
        return { buffer: null, useSynth: true, gain: sideGain, source: null };
      }
    };

    const [proSide, conSide] = await Promise.all([loadSide("pro"), loadSide("con")]);
    sidesRef.current = { pro: proSide, con: conSide };

    if (ctx.state === "suspended") await ctx.resume();
    setReady(true);
  }, [muted]);

  const stop = useCallback((side: Side) => {
    const ctx = ctxRef.current;
    const sides = sidesRef.current;
    if (!ctx || !sides) return;
    const entry = sides[side];
    entry.gain.gain.cancelScheduledValues(ctx.currentTime);
    entry.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.12);
    if (entry.source) {
      const src = entry.source;
      // Schedule the source to stop just after the fade completes; it
      // will be garbage-collected once it disconnects itself onended.
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
      entry.source = null;
    }
  }, []);

  const play = useCallback(
    (side: Side) => {
      const ctx = ctxRef.current;
      const sides = sidesRef.current;
      const master = masterGainRef.current;
      if (!ctx || !sides || !master) return;
      if (muted) return;

      // Stop any previous source for this side to avoid overlap.
      stop(side);

      const entry = sides[side];
      const targetGain = side === "pro" ? 0.32 : 0.4;

      if (entry.buffer && !entry.useSynth) {
        // Real CC0 file — loop it gently.
        const src = ctx.createBufferSource();
        src.buffer = entry.buffer;
        src.loop = true;
        src.connect(entry.gain);
        entry.gain.gain.cancelScheduledValues(ctx.currentTime);
        entry.gain.gain.setValueAtTime(0, ctx.currentTime);
        entry.gain.gain.linearRampToValueAtTime(targetGain, ctx.currentTime + 0.12);
        src.start();
        entry.source = src;
        return;
      }

      // Synth fallback. Build a small cartoon chirp/croak using a single
      // oscillator with a vibrato LFO and a slow gain wobble so it
      // doesn't sound like a sine wave humming.
      const osc = ctx.createOscillator();
      osc.type = side === "pro" ? "triangle" : "sawtooth";
      const baseHz = side === "pro" ? 520 : 110;
      osc.frequency.value = baseHz;

      // Vibrato LFO modulates the pitch a bit so it sounds frog-ish.
      const lfo = ctx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = side === "pro" ? 9 : 5.5;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = side === "pro" ? 32 : 14;
      lfo.connect(lfoGain).connect(osc.frequency);
      lfo.start();

      // Tremolo wobble on amplitude so it pulses like chirps/croaks
      // rather than a steady tone.
      const tremolo = ctx.createOscillator();
      tremolo.type = "sine";
      tremolo.frequency.value = side === "pro" ? 6.5 : 3.2;
      const tremoloGain = ctx.createGain();
      tremoloGain.gain.value = 0.55;
      tremolo.connect(tremoloGain).connect(entry.gain.gain);
      tremolo.start();

      osc.connect(entry.gain);
      entry.gain.gain.cancelScheduledValues(ctx.currentTime);
      entry.gain.gain.setValueAtTime(0, ctx.currentTime);
      entry.gain.gain.linearRampToValueAtTime(targetGain, ctx.currentTime + 0.12);
      osc.start();
      entry.source = osc;
      // We don't track lfo/tremolo separately — they'll be disconnected
      // when the osc.onended fires after stop() schedules osc.stop().
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
      sidesRef.current = null;
      masterGainRef.current = null;
    };
  }, []);

  return { ready, muted, toggleMute, unlock, play, stop };
}
