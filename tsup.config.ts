import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/consensus/*.ts",
    "src/debate/*.ts",
    "src/models/*.ts",
    "src/panel/*.ts",
    "src/providers/*.ts",
    "src/publishing/*.ts",
    "src/runs/*.ts",
    "src/workflows/*.ts"
  ],
  format: ["esm"],
  dts: true,
  splitting: true,
  sourcemap: true,
  clean: true,
  target: "node20"
});
