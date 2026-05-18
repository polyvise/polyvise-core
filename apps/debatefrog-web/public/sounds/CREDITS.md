# Frog sounds for /froglings

The funner experience uses a **shared pool** of frog clips: both the
pro and the con frog randomly pick a clip from the pool when they
start speaking. There is no per-side audio — every clip can play for
either side.

## Currently shipping

All four clips in this folder are trimmed excerpts from a single
field recording of Pacific Chorus Frogs by **daveincamas** on
Freesound:

| File         | Source                                                                                                   | License                                                                              | Author        |
| ------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------- |
| `frog1.wav`  | [Freesound #32834](https://freesound.org/people/daveincamas/sounds/32834/) (trimmed excerpt, modified)   | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)                            | daveincamas   |
| `frog2.wav`  | [Freesound #32834](https://freesound.org/people/daveincamas/sounds/32834/) (trimmed excerpt, modified)   | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)                            | daveincamas   |
| `frog3.wav`  | [Freesound #32834](https://freesound.org/people/daveincamas/sounds/32834/) (trimmed excerpt, modified)   | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)                            | daveincamas   |
| `frog4.wav`  | [Freesound #32834](https://freesound.org/people/daveincamas/sounds/32834/) (trimmed excerpt, modified)   | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)                            | daveincamas   |

Original work:
**"200703101950PacificChorusFrogsConfrontAirplane.wav"** by daveincamas
on Freesound, 27 March 2007 — a 1:48 binaural stereo field recording
of Pacific Chorus Frogs reacting to an approaching propeller airplane.
Each of the four clips here is a short excerpt taken from that
recording.

CC BY 4.0 requires attribution. The deployed `/froglings` page shows
a small "Sounds by daveincamas (CC BY)" link in the footer that
points at the Freesound page, which together with this CREDITS.md
satisfies the license. If you swap or remove these clips, also update
the in-app attribution in `apps/debatefrog-web/src/components/froglings-workspace.tsx`.

## File layout

Drop files in this folder named `frog<N>.<ext>` where `<N>` is any
positive integer (e.g. `frog1`, `frog2`, ...) and `<ext>` is one of
`wav`, `ogg`, or `mp3`. The build-time manifest script discovers
them automatically.

If a clip ships in multiple formats, the loader picks the first one
the browser can play in this order: **wav → ogg → mp3**. You only
need one format per clip; shipping multiple just helps older
browsers.

If no `frog<N>.*` files are present at all, the hook drops to a
small Web Audio synthesizer that approximates a cartoon chirp /
croak so the page works out of the box.

## Random rotation, not per-side

An earlier iteration used `pro-chirp.*` and `con-croak.*` — one
fixed sound per side. The current model rotates randomly through
the shared pool, which feels more lively. As a small refinement,
when both frogs happen to be typing at the same moment, the picker
avoids the clip already playing on the other side, so they don't
sound identical. Each play also gets a tiny random pitch jitter
(~±8%) for organic variation.

## Cache busting — you don't have to think about this

When you change a sound file, the build re-runs
`scripts/generate-audio-manifest.mjs`, which writes
`src/lib/audio-manifest.ts` with a SHA-1 of each file's contents.
The hook appends that hash as `?v=<hash>` on every fetch, so the
browser sees a different URL and fetches the new bytes without any
hard-refresh needed. The script runs automatically as `predev` and
`prebuild`; you can also run it manually with
`npm run audio:manifest -w @polyvise/debatefrog-web`.

## Format choice — short version

- **WAV** is uncompressed PCM. Files are large per second but tiny
  in absolute terms for short loops (~100–300 KB per 1-second clip).
  Decodes natively everywhere, no codec questions, no quality loss.
  This is what's currently shipping.
- **OGG (Vorbis)** is smaller at the same perceived quality (~10×
  smaller than WAV) and is supported by every evergreen browser plus
  Safari 18+. Worth transcoding to if you have many or longer clips.
- **MP3** is universally supported. Useful as a fallback for the
  small handful of browsers that still don't decode OGG cleanly.

## File spec (for replacement clips)

- Length: 0.4–1.5 seconds — the hook loops the clip while a frog
  speaks, so anything longer is wasted bytes.
- Loudness: target around -16 LUFS so the audio sits gently under
  speech; the hook applies an additional volume duck via Web Audio's
  GainNode.
- Encoding when transcoding: Vorbis quality ~3 (≈96 kbps) is plenty
  for a short loop. MP3 128 kbps CBR is fine. WAV: 16-bit/44.1 kHz
  is more than enough.

## Recommended sources for future clips

Search these on freesound.org and filter to CC0 / Public Domain
(easier than CC BY for attribution-free use):

- https://freesound.org/search/?q=frog+chirp&f=license:%22Creative+Commons+0%22
- https://freesound.org/search/?q=tree+frog&f=license:%22Creative+Commons+0%22
- https://freesound.org/search/?q=bullfrog+croak&f=license:%22Creative+Commons+0%22
- https://freesound.org/search/?q=frog+ribbit&f=license:%22Creative+Commons+0%22

If you pick a CC BY clip instead, remember to add a row to the
table at the top of this file AND update the in-app attribution
in `froglings-workspace.tsx`.
