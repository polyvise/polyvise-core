# Frog sounds for /froglings

The funner experience uses a **shared pool** of frog clips: both the
pro and the con frog randomly pick a clip from the pool when they
start speaking. There is no per-side audio — every clip can play for
either side.

## File layout

Drop files in this folder named `frog<N>.<ext>` where `<N>` is any
positive integer (e.g. `frog1`, `frog2`, ...) and `<ext>` is one of
`wav`, `ogg`, or `mp3`. The build-time manifest script discovers
them automatically.

| File              | Notes                                                |
| ----------------- | ---------------------------------------------------- |
| `frog1.wav`       | One clip. WAV decodes everywhere natively.           |
| `frog1.ogg`       | Same clip in OGG — optional, slightly smaller.       |
| `frog1.mp3`       | Same clip in MP3 — optional fallback.                |
| `frog2.wav` …     | Add as many `frog<N>.*` clips as you like.           |

If a clip ships in multiple formats, the loader picks the first one
the browser can play in this order: **wav → ogg → mp3**. You only
need one format per clip; shipping multiple just helps older
browsers.

If no `frog<N>.*` files are present at all, the hook drops to a
small Web Audio synthesizer that approximates a cartoon chirp /
croak so the page works out of the box.

## Why no `pro-*` / `con-*` files anymore

An earlier iteration of this folder used `pro-chirp.*` and
`con-croak.*` — one fixed sound per side. The current model rotates
randomly through the shared pool, which feels more lively. As a
small refinement, when both frogs happen to be typing at the same
moment, the picker avoids the clip already playing on the other
side, so they don't sound identical. Each play also gets a tiny
random pitch jitter (~±8%) for organic variation.

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
  This is the easy choice for a handful of short clips.
- **OGG (Vorbis)** is smaller at the same perceived quality (~10×
  smaller than WAV) and is supported by every evergreen browser plus
  Safari 18+. Worth transcoding to if you have many or longer clips.
- **MP3** is universally supported. Useful as a fallback for the
  small handful of browsers that still don't decode OGG cleanly.

## Recommended sources (CC0 / public domain)

Search these on freesound.org and pick clips you like that are
licensed CC0 / Public Domain (not just "Attribution"):

- https://freesound.org/search/?q=frog+chirp&f=license:%22Creative+Commons+0%22
- https://freesound.org/search/?q=tree+frog&f=license:%22Creative+Commons+0%22
- https://freesound.org/search/?q=bullfrog+croak&f=license:%22Creative+Commons+0%22
- https://freesound.org/search/?q=frog+ribbit&f=license:%22Creative+Commons+0%22

## File spec

- Length: 0.4–1.5 seconds — the hook loops the clip while a frog
  speaks, so anything longer is wasted bytes.
- Loudness: target around -16 LUFS so the audio sits gently under
  speech; the hook applies an additional volume duck via Web Audio's
  GainNode.
- Encoding when transcoding: Vorbis quality ~3 (≈96 kbps) is plenty
  for a short loop. MP3 128 kbps CBR is fine. WAV: 16-bit/44.1 kHz
  is more than enough.

## Crediting

If a clip is CC0 you don't legally need to credit, but it's polite.
Add a line below for any clip that ships with the repo.

| File            | Source URL | License | Author |
| --------------- | ---------- | ------- | ------ |
| frog1.*         | _(empty — currently synthesized)_ | _n/a_ | _n/a_ |
| frog2.*         | _(empty — currently synthesized)_ | _n/a_ | _n/a_ |
| frog3.*         | _(empty — currently synthesized)_ | _n/a_ | _n/a_ |
| frog4.*         | _(empty — currently synthesized)_ | _n/a_ | _n/a_ |
