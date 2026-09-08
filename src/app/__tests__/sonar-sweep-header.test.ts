import { describe, expect, it } from "vitest";
import { SETTINGS_GEAR_HREF } from "../sonar-sweep-header";

// header-layout-cleanup epic, settings-gear-icon-in-masthead story:
// SonarSweepHeader is a "use client" component with hooks (useEffect/
// useState), and this repo has no React Testing Library / jsdom setup
// (see nav-header.test.ts's own comment on the same constraint) -- so,
// matching that file's established convention, the assertable contract is
// pulled out into a plain exported constant instead of rendering the DOM.
// Asserting on SETTINGS_GEAR_HREF is equivalent to asserting the rendered
// gear icon <Link>'s href.
describe("SETTINGS_GEAR_HREF", () => {
  it("points at /config, not /setup", () => {
    // The owner explicitly deferred the Setup-vs-Config nav tab
    // consolidation decision -- /config is picked as the smallest, safest
    // choice that doesn't presuppose that decision's outcome (see the
    // story's own design_decisions).
    expect(SETTINGS_GEAR_HREF).toBe("/config");
  });
});
