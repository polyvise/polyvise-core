import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/debate/*.ts",
    "src/models/*.ts",
    "src/providers/*.ts",
    "src/publishing/*.ts",
    "src/workflows/*.ts"
  ],
  format: ["esm"],
  dts: true,
  splitting: true,
  sourcemap: true,
  clean: true,
  target: "node20"
});
