# Frog sounds for /froglings

The funner experience expects two audio files in this folder:

| File              | When it plays                                              |
| ----------------- | ---------------------------------------------------------- |
| `pro-chirp.mp3`   | Loops softly while the pro frog's argument is being typed. |
| `con-croak.mp3`   | Loops softly while the con frog's argument is being typed. |

If either file is missing, `useFrogSounds()` falls back to a small Web
Audio synthesizer that approximates a cartoon chirp / croak. The synth
fallback is intentional so the page works out of the box — but a real
clip will sound much better.

## Recommended sources (CC0 / public domain)

Search these on freesound.org and pick a clip you like that is licensed
CC0 / Public Domain (not just "Attribution"):

- Pro chirp candidates:
  - https://freesound.org/search/?q=frog+chirp&f=license:%22Creative+Commons+0%22
  - https://freesound.org/search/?q=tree+frog&f=license:%22Creative+Commons+0%22

- Con croak candidates:
  - https://freesound.org/search/?q=bullfrog+croak&f=license:%22Creative+Commons+0%22
  - https://freesound.org/search/?q=frog+ribbit&f=license:%22Creative+Commons+0%22

## File format & length

- Format: MP3 (browsers all support it, and the file size stays small)
- Length: 0.4–1.5 seconds — the hook loops the clip while a frog speaks,
  so anything longer is wasted bytes.
- Loudness: target around -16 LUFS so the audio sits gently under speech;
  the hook applies an additional volume duck via Web Audio's GainNode.

## Crediting

If the clip you pick is CC0 you don't legally need to credit, but it's
polite. Add a line below for any clip that ships with the repo.

| File            | Source URL | License | Author |
| --------------- | ---------- | ------- | ------ |
| pro-chirp.mp3   | _(empty — currently synthesized)_ | _n/a_ | _n/a_ |
| con-croak.mp3   | _(empty — currently synthesized)_ | _n/a_ | _n/a_ |
