import { describe, expect, it } from "vitest";
import { mergeDedupe } from "../merge.js";

describe("mergeDedupe: case-insensitive, trimmed dedup (resume-link-ui story AC)", () => {
  it("appends genuinely new entries after the existing ones, preserving existing order", () => {
    expect(mergeDedupe(["TypeScript"], ["React", "Node.js"])).toEqual(["TypeScript", "React", "Node.js"]);
  });

  it("drops an incoming entry that matches an existing one case-insensitively ('React' vs 'react')", () => {
    expect(mergeDedupe(["React"], ["react"])).toEqual(["React"]);
    expect(mergeDedupe(["react"], ["React"])).toEqual(["react"]);
  });

  it("drops an incoming entry that matches an existing one after trimming whitespace", () => {
    expect(mergeDedupe(["TypeScript"], ["  TypeScript  "])).toEqual(["TypeScript"]);
    expect(mergeDedupe(["  TypeScript  "], ["TypeScript"])).toEqual(["  TypeScript  "]);
  });

  it("does NOT dedup genuinely different strings that merely resemble each other ('Node.js' vs 'NodeJS') — accepted, documented limitation", () => {
    expect(mergeDedupe(["Node.js"], ["NodeJS"])).toEqual(["Node.js", "NodeJS"]);
  });

  it("dedups duplicates within the incoming list itself, not just against existing", () => {
    expect(mergeDedupe([], ["Go", "go", "GO", "Rust"])).toEqual(["Go", "Rust"]);
  });

  it("trims whitespace off a genuinely-new appended entry", () => {
    expect(mergeDedupe([], ["  Kubernetes  "])).toEqual(["Kubernetes"]);
  });

  it("drops blank/whitespace-only incoming entries instead of appending empty rows", () => {
    expect(mergeDedupe(["Existing"], ["", "   ", "New"])).toEqual(["Existing", "New"]);
  });

  it("returns a copy of existing (with nothing appended) when incoming is empty, without mutating the input", () => {
    const existing = ["A", "B"];
    const result = mergeDedupe(existing, []);
    expect(result).toEqual(["A", "B"]);
    expect(result).not.toBe(existing);
  });

  it("never mutates either input array", () => {
    const existing = ["A"];
    const incoming = ["B"];
    mergeDedupe(existing, incoming);
    expect(existing).toEqual(["A"]);
    expect(incoming).toEqual(["B"]);
  });

  it("handles a fully-empty existing draft, deduping and trimming everything from incoming alone", () => {
    expect(mergeDedupe([], ["Fractional CTO", " fractional cto ", "Engineering Leadership"])).toEqual([
      "Fractional CTO",
      "Engineering Leadership",
    ]);
  });
});
