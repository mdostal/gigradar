// runner-registry-and-sidecar-lifecycle epic, shared-source-registration
// story: every adapter below calls registerSource(...) as a MODULE-LOAD
// side effect (see source.ts's registry) -- getSource(id) only finds an
// adapter once its module has actually been imported in the CURRENT
// process. Three entry points each used to hand-maintain their own copy
// of this exact list (src/lib/apply/runner.ts's CLI main(),
// src/scheduler/index.ts) before ever calling runRadar() -- this is that
// list, extracted once.
//
// Deliberately DYNAMIC import() calls, never static top-level imports:
// runner.test.ts imports runRadar() directly and registers its own
// network-free test-double sources under the SAME ids (e.g. "braintrust")
// in that same test process -- a static top-level import here would load
// the real adapters into that process too and crash on "duplicate source
// id" the moment this module is merely imported, not even called.
//
// No manual "already registered" flag: Node's ES module cache makes
// repeated import() calls of the same specifier, within one process,
// idempotent -- a module's top-level code (including its
// registerSource() call) runs exactly once no matter how many times
// this function is called.
//
// src/mcp/server.ts deliberately keeps its OWN static top-level imports
// rather than using this helper -- it's a separate, standalone,
// long-lived process with no test-double collision risk, and static
// imports there are simpler, not broken.
export async function registerAllSources(): Promise<void> {
  await Promise.all([
    import("./braintrust.js"),
    import("./builtin.js"),
    import("./gofractional.js"),
    import("./ateam.js"),
    import("./fractionaljobs.js"),
    import("./fractionus.js"),
    import("./fractionalfinders.js"),
    import("./wellfound.js"),
    import("./linkedin.js"),
  ]);
}
