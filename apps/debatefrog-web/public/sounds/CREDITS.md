# Frog sounds for /froglings

The funner experience expects up to four audio files in this folder.
You only need **one format per side** (the hook picks the best one
available); shipping both formats just gives older Safari builds a
fallback.

| File              | Required? | When it plays                                              |
| ----------------- | --------- | ---------------------------------------------------------- |
| `pro-chirp.ogg`   | preferred | Loops softly while the pro frog's argument is being typed. |
| `pro-chirp.mp3`   | fallback  | Used when the browser can't play .ogg.                     |
| `con-croak.ogg`   | preferred | Loops softly while the con frog's argument is being typed. |
| `con-croak.mp3`   | fallback  | Used when the browser can't play .ogg.                     |

If neither format is present for a side, `useFrogSounds()` drops to a
small Web Audio synthesizer that approximates a cartoon chirp / croak.
The synth fallback is intentional so the page works out of the box, but
a real clip will sound much better.

## Format choice — short version

- **OGG (Vorbis)** is smaller at the same perceived quality and is
  supported by every evergreen browser plus Safari 18+. Use it as your
  primary format if you can.
- **MP3** is universally supported. If you only ship one format, ship
  this one — it's the safe choice.

## Cache busting — you don't have to think about this

When you change a sound file, the build re-runs
`scripts/generate-audio-manifest.mjs`, which writes
`src/lib/audio-manifest.ts` with a SHA-1 of each file's contents. The
hook appends that hash as `?v=<hash>` on every fetch, so the browser
sees a different URL and fetches the new bytes without any hard-refresh
needed. The script runs automatically as `predev` and `prebuild`; you
can also run it manually with `npm run audio:manifest -w
@polyvise/debatefrog-web`.

## Recommended sources (CC0 / public domain)

Search these on freesound.org and pick a clip you like that is licensed
CC0 / Public Domain (not just "Attribution"):

- Pro chirp candidates:
  - https://freesound.org/search/?q=frog+chirp&f=license:%22Creative+Commons+0%22
  - https://freesound.org/search/?q=tree+frog&f=license:%22Creative+Commons+0%22

- Con croak candidates:
  - https://freesound.org/search/?q=bullfrog+croak&f=license:%22Creative+Commons+0%22
  - https://freesound.org/search/?q=frog+ribbit&f=license:%22Creative+Commons+0%22

## File spec

- Length: 0.4–1.5 seconds — the hook loops the clip while a frog speaks,
  so anything longer is wasted bytes.
- Loudness: target around -16 LUFS so the audio sits gently under
  speech; the hook applies an additional volume duck via Web Audio's
  GainNode.
- Encoding for OGG: Vorbis quality ~3 (≈96 kbps) is plenty for a short
  loop. For MP3, 128 kbps CBR is fine.

## Crediting

If the clip is CC0 you don't legally need to credit, but it's polite.
Add a line below for any clip that ships with the repo.

| File            | Source URL | License | Author |
| --------------- | ---------- | ------- | ------ |
| pro-chirp.ogg   | _(empty — currently synthesized)_ | _n/a_ | _n/a_ |
| pro-chirp.mp3   | _(empty — currently synthesized)_ | _n/a_ | _n/a_ |
| con-croak.ogg   | _(empty — currently synthesized)_ | _n/a_ | _n/a_ |
| con-croak.mp3   | _(empty — currently synthesized)_ | _n/a_ | _n/a_ |
