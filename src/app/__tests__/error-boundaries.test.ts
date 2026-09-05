import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import GlobalError from "../global-error";
import ConfigError from "../config/error";
import GigsError from "../gigs/error";
import GroupError from "../[group]/error";

// group-feature-hardening-and-coverage epic, app-error-boundaries story.
// This repo has no React Testing Library/jsdom, and vitest here has no JSX
// transform configured (jsx test files render via createElement()
// elsewhere in this codebase never having existed before this file) --
// renderToStaticMarkup() + createElement() works in plain Node with zero
// new config, and is enough to prove each boundary renders without
// throwing and surfaces a working "Try again" control.
const err = Object.assign(new Error("boom"), { digest: "abc123" });

describe("error boundaries", () => {
  it("global-error.tsx renders its own <html>/<body> with a Try again control", () => {
    const html = renderToStaticMarkup(createElement(GlobalError, { error: err, reset: () => {} }));
    expect(html).toContain("<html");
    expect(html).toContain("<body");
    expect(html).toContain("Try again");
  });

  it("config/error.tsx renders a recoverable fallback naming the route", () => {
    const html = renderToStaticMarkup(createElement(ConfigError, { error: err, reset: () => {} }));
    expect(html).toContain("Config");
    expect(html).toContain("Try again");
  });

  it("gigs/error.tsx renders a recoverable fallback naming the route", () => {
    const html = renderToStaticMarkup(createElement(GigsError, { error: err, reset: () => {} }));
    expect(html).toContain("All Gigs");
    expect(html).toContain("Try again");
  });

  it("[group]/error.tsx renders a recoverable fallback", () => {
    const html = renderToStaticMarkup(createElement(GroupError, { error: err, reset: () => {} }));
    expect(html).toContain("this group&#x27;s view");
    expect(html).toContain("Try again");
  });
});
