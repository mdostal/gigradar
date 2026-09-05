import path from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Mirrors tsconfig.json's "@/*" -> "src/*" path alias (the same one
// next.config.js/Next's own bundler resolves) so files under src/app that
// import via "@/lib/..." — matching this repo's Next-side convention — can
// be unit-tested directly with vitest, not just typechecked by tsc.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(dirname, "src"),
    },
  },
  // app-error-boundaries story (group-feature-hardening-and-coverage
  // epic): the first vitest file to import a real .tsx component and
  // render it (via react-dom/server, no jsdom needed) rather than only
  // testing plain exported functions -- esbuild's default classic JSX
  // transform expects a `React` global in scope, which none of this
  // repo's .tsx files provide (Next's own SWC pipeline normally handles
  // that). Scoped to vitest's own esbuild pass only; Next's production
  // build is untouched.
  esbuild: {
    jsx: "automatic",
  },
  test: {
    // Global safety net -- see vitest.setup.ts's own header comment: no
    // test should ever be able to write to the owner's real gigradar
    // database, even incidentally.
    setupFiles: ["./vitest.setup.ts"],
    // playwright-e2e-scaffold-and-ci story: tests/e2e/*.spec.ts are real
    // Playwright specs (run via `npm run test:e2e`), not vitest tests --
    // they use @playwright/test's own test()/expect(), incompatible with
    // vitest's runner. Exclude the whole directory alongside vitest's own
    // default node_modules exclusion.
    exclude: [...configDefaults.exclude, "tests/e2e/**"],
  },
});
