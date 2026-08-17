import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts", "src/plugin.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  // dist/ is committed to git (see .gitignore) so consumers installing via
  // a git dependency get a working package with no install-time build
  // step. This is required, not just an optimization: npm's git-dependency
  // fetcher (pacote) spawns a nested `npm install` whenever the cloned
  // package.json defines a `build`/`prepare`/`postinstall`/etc script, and
  // that nested install fails inside OpenCode's bundled npm — so none of
  // this package's own dev scripts may use those names (see
  // `build:tsup` instead of `build`, and no `prepare` script). Sourcemaps
  // would just be extra diff noise on every rebuild-and-recommit with no
  // runtime benefit for how this package is consumed.
  sourcemap: false,
  external: ["@cursor/sdk", "@ai-sdk/openai-compatible"],
})
