#!/usr/bin/env node
/**
 * generate-audio-manifest.mjs — regenerates src/lib/audio-manifest.ts
 * from the contents of public/sounds/.
 *
 * Why: browsers cache static assets aggressively, so if you swap
 * pro-chirp.mp3 for a new clip the old one keeps playing until a hard
 * reload. By computing a SHA-1 of each file at build time and using it
 * as a `?v=<hash>` query parameter, the URL changes whenever the file
 * changes, and the browser fetches the new bytes automatically.
 *
 * The script runs as `predev` and `prebuild` in this package's
 * package.json so the manifest is always fresh.
 *
 * Looked-for files (all optional):
 *   public/sounds/pro-chirp.mp3
 *   public/sounds/pro-chirp.ogg
 *   public/sounds/con-croak.mp3
 *   public/sounds/con-croak.ogg
 *
 * The hook (`use-frog-sounds.ts`) prefers .ogg when the browser
 * supports it (smaller files, slightly higher quality at the same
 * bitrate), falls back to .mp3 when present, and finally to a
 * procedural Web Audio synth when neither exists.
 */

import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");
const soundsDir = join(appRoot, "public", "sounds");
const outFile = join(appRoot, "src", "lib", "audio-manifest.ts");

const sides = /** @type {const} */ (["pro", "con"]);
const baseName = { pro: "pro-chirp", con: "con-croak" };
const formats = /** @type {const} */ (["mp3", "ogg"]);

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

async function main() {
  /** @type {Record<string, Record<string, { exists: true; hash: string } | { exists: false }>>} */
  const manifest = {};
  for (const side of sides) {
    manifest[side] = {};
    for (const fmt of formats) {
      const filename = `${baseName[side]}.${fmt}`;
      manifest[side][fmt] = await fileEntry(join(soundsDir, filename));
    }
  }

  const generated =
    "// AUTO-GENERATED FILE — do not edit by hand.\n" +
    "// Regenerated from apps/debatefrog-web/public/sounds/ by\n" +
    "// scripts/generate-audio-manifest.mjs on every predev / prebuild.\n" +
    "// See use-frog-sounds.ts for how this is consumed.\n\n" +
    "export type AudioFormat = \"mp3\" | \"ogg\";\n\n" +
    "export type AudioEntry =\n" +
    "  | { exists: true; hash: string }\n" +
    "  | { exists: false };\n\n" +
    "export type AudioSide = \"pro\" | \"con\";\n\n" +
    "export const audioFileNames: Record<AudioSide, string> = {\n" +
    "  pro: \"pro-chirp\",\n" +
    "  con: \"con-croak\"\n" +
    "};\n\n" +
    `export const audioManifest: Record<AudioSide, Record<AudioFormat, AudioEntry>> = ${JSON.stringify(
      manifest,
      null,
      2
    )} as const;\n`;

  await writeFile(outFile, generated, "utf8");

  // Friendly summary at the bottom of console output so anyone running
  // dev/build sees which files we found.
  const summary = sides
    .flatMap((side) =>
      formats
        .filter((fmt) => manifest[side][fmt].exists)
        .map((fmt) => `  ✓ ${baseName[side]}.${fmt} (hash ${/** @type {any} */(manifest[side][fmt]).hash})`)
    )
    .join("\n");
  if (summary) {
    console.log("[audio-manifest] picked up:\n" + summary);
  } else {
    console.log(
      "[audio-manifest] no real audio files found — /froglings will use the synth fallback. " +
        "See public/sounds/CREDITS.md for how to add CC0 clips."
    );
  }
}

main().catch((err) => {
  console.error("[audio-manifest] failed:", err);
  process.exit(1);
});
