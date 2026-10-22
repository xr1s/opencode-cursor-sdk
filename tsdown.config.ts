import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/index.ts", "src/plugin.ts"],
  format: ["esm"],
  // TypeScript 7 ships the compiler only as a native binary, so d.ts files are
  // generated with the tsgo (native) generator instead of the JS compiler API.
  dts: {
    generator: "tsgo",
  },
  clean: true,
  // Keep runtime dependencies external so the package continues to load them
  // from the host OpenCode installation.
  deps: {
    neverBundle: ["@cursor/sdk", "@ai-sdk/openai-compatible"],
  },
  sourcemap: false,
})
