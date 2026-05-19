#!/usr/bin/env node
/**
 * generate-audio-manifest.mjs — regenerates src/lib/audio-manifest.ts
 * from the contents of public/sounds/.
 *
 * Model: DebateFrog uses a shared pool of frog sounds for the YES and
 * NO frogs while the judge prefers frog5 when it is present.
 *
 * Looked-for files:
 *   public/sounds/frog<N>.wav   (preferred — what the user has)
 *   public/sounds/frog<N>.ogg   (optional — smaller, slightly higher quality)
 *   public/sounds/frog<N>.mp3   (optional — universal fallback)
 *
 * <N> is any positive integer; the script discovers every `frog<N>.<ext>`
 * file present, groups them by id, and lists the available formats with
 * a SHA-1 content hash for cache-busting.
 *
 * Why cache-busting: browsers cache static assets aggressively. The
 * useFrogSounds hook appends `?v=<hash>` from this manifest to every
 * fetch, so swapping a clip on disk forces a fresh download with no
 * hard-refresh dance.
 *
 * The script runs as `predev` and `prebuild` in this package's
 * package.json so the manifest is always fresh. Also exposed as
 * `npm run audio:manifest` for manual regeneration.
 */

import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");
const soundsDir = join(appRoot, "public", "sounds");
const outFile = join(appRoot, "src", "lib", "audio-manifest.ts");

const formats = /** @type {const} */ (["wav", "ogg", "mp3"]);
const CLIP_RE = /^frog(\d+)\.(wav|ogg|mp3)$/i;

/**
 * @param {string} path
 * @returns {Promise<{ exists: true; hash: string } | { exists: false }>}
 */
async function fileEntry(path) {
  try {
    const st = await stat(path);
    if (!st.isFile()) return { exists: false };
    const bytes = await readFile(path);
    const hash = createHash("sha1").update(bytes).digest("hex").slice(0, 10);
    return { exists: true, hash };
  } catch {
    return { exists: false };
  }
}

async function discoverClipIds() {
  /** @type {Set<string>} */
  const ids = new Set();
  try {
    const entries = await readdir(soundsDir);
    for (const name of entries) {
      const match = CLIP_RE.exec(name);
      if (match) ids.add(`frog${match[1]}`);
    }
  } catch {
    // soundsDir may not exist on a brand-new checkout. That's fine —
    // the manifest will just have an empty clips array and the hook
    // will drop to the synth fallback.
  }
  return Array.from(ids).sort((a, b) => {
    const an = Number(a.replace(/^frog/, ""));
    const bn = Number(b.replace(/^frog/, ""));
    return an - bn;
  });
}

async function main() {
  const ids = await discoverClipIds();

  /** @type {{ id: string; formats: Record<string, { exists: true; hash: string } | { exists: false }> }[]} */
  const clips = [];
  for (const id of ids) {
    /** @type {Record<string, { exists: true; hash: string } | { exists: false }>} */
    const fmtEntries = {};
    for (const fmt of formats) {
      fmtEntries[fmt] = await fileEntry(join(soundsDir, `${id}.${fmt}`));
    }
    clips.push({ id, formats: fmtEntries });
  }

  const generated =
    "// AUTO-GENERATED FILE — do not edit by hand.\n" +
    "// Regenerated from apps/debatefrog-web/public/sounds/ by\n" +
    "// scripts/generate-audio-manifest.mjs on every predev / prebuild.\n" +
    "// See use-frog-sounds.ts for how this is consumed.\n\n" +
    "export type AudioFormat = \"wav\" | \"ogg\" | \"mp3\";\n\n" +
    "export type AudioEntry =\n" +
    "  | { exists: true; hash: string }\n" +
    "  | { exists: false };\n\n" +
    "export interface AudioClip {\n" +
    "  /** Stable file-id like 'frog1', 'frog2', ... */\n" +
    "  id: string;\n" +
    "  /** Per-format presence + content hash. */\n" +
    "  formats: Record<AudioFormat, AudioEntry>;\n" +
    "}\n\n" +
    "/**\n" +
    " * Frog clips discovered from public/sounds/. YES and NO frogs draw\n" +
    " * randomly from the shared pool, while the judge prefers frog5 when\n" +
    " * it is present.\n" +
    " */\n" +
    `export const audioClips: readonly AudioClip[] = ${JSON.stringify(
      clips,
      null,
      2
    )} as const;\n`;

  await writeFile(outFile, generated, "utf8");

  if (clips.length === 0) {
    console.log(
      "[audio-manifest] no frog<N>.{wav,ogg,mp3} files found — /froglings will use the synth fallback. " +
        "See public/sounds/CREDITS.md for how to add clips."
    );
    return;
  }
  const summary = clips
    .flatMap((clip) =>
      formats
        .filter((fmt) => clip.formats[fmt].exists)
        .map(
          (fmt) =>
            `  ✓ ${clip.id}.${fmt} (hash ${/** @type {any} */ (clip.formats[fmt]).hash})`
        )
    )
    .join("\n");
  console.log(`[audio-manifest] picked up ${clips.length} clip(s):\n${summary}`);
}

main().catch((err) => {
  console.error("[audio-manifest] failed:", err);
  process.exit(1);
});
