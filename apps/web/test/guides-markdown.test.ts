/**
 * The guides tab renders three real documents with a hand-rolled markdown
 * parser instead of a library (see Guides.tsx for why). That trade is only
 * honest if the parser is checked against the actual files rather than against
 * a fixture written to suit it — so this asserts the block counts the parser
 * produces AGAINST THE MARKDOWN ITSELF, for every guide, on every run.
 *
 * The failure it exists to catch is silent: a parser that swallows a fenced
 * block loses a command the integrator was meant to run, and the page still
 * looks fine. Nobody notices by reading it.
 *
 * The expectations are computed here with fence-aware counters, and that is the
 * point rather than an implementation detail. A naive `/^#{1,6} /` over the
 * whole file counts 18 headings in issue-a-credential.md; four of them are `#`
 * shell comments inside code blocks, and treating those as headings is exactly
 * the bug the counters below would otherwise bless.
 */
import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../src/components/Guides.js";
import issueACredential from "../../../docs/api/guides/issue-a-credential.md?raw";
import receiveWebhooks from "../../../docs/api/guides/receive-webhooks.md?raw";
import tokenizeAnAsset from "../../../docs/api/guides/tokenize-an-asset.md?raw";

const GUIDES = [
  ["issue-a-credential", issueACredential],
  ["receive-webhooks", receiveWebhooks],
  ["tokenize-an-asset", tokenizeAnAsset],
] as const;

/** Walk the source once, counting only what is OUTSIDE a fenced block. */
function expectedCounts(source: string): { fences: number; headings: number; tables: number; items: number } {
  let inFence = false;
  let fences = 0, headings = 0, tables = 0, items = 0;
  for (const line of source.split("\n")) {
    if (/^```/.test(line.trim())) {
      if (!inFence) fences++;
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^#{1,6}\s/.test(line)) headings++;
    if (/^\|[\s:|-]+\|$/.test(line.trim())) tables++;
    if (/^([-*]\s|\d+\.\s)/.test(line)) items++;
  }
  return { fences, headings, tables, items };
}

describe.each(GUIDES)("%s", (name, source) => {
  const blocks = parseMarkdown(source);
  const expected = expectedCounts(source);
  const count = (kind: string): number => blocks.filter((b) => b.kind === kind).length;

  it("is a real file imported as raw text, not a transcription", () => {
    // The whole point of the `?raw` import: task D1-7 verifies the docs/ copies
    // by EXECUTING them, and a second copy pasted into a TSX file would never
    // be corrected. An empty or stub import means the build stopped resolving
    // the path out of apps/web and the tab is showing nothing.
    expect(source.length).toBeGreaterThan(2000);
    expect(source.startsWith("# ")).toBe(true);
  });

  it("keeps every fenced code block — each one is a command someone is meant to run", () => {
    expect(count("code")).toBe(expected.fences);
    expect(expected.fences).toBeGreaterThan(0);
  });

  it("reads headings and tables outside code fences only", () => {
    expect(count("heading")).toBe(expected.headings);
    expect(count("table")).toBe(expected.tables);
  });

  it("keeps every list item", () => {
    const items = blocks.reduce((n, b) => n + (b.kind === "list" ? b.items.length : 0), 0);
    expect(items).toBe(expected.items);
  });

  it("leaves no block markers stranded in a paragraph", () => {
    // A fence, a table row or a heading marker that survived into paragraph
    // text means the block parser fell through and the reader sees raw markdown.
    const stranded = blocks.filter((b) => b.kind === "paragraph" && /^(```|\||#{1,6}\s|>)/.test(b.text));
    expect(stranded).toEqual([]);
  });

  it("produces no empty blocks", () => {
    const empty = blocks.filter((b) =>
      (b.kind === "paragraph" && b.text.trim() === "") ||
      (b.kind === "heading" && b.text.trim() === "") ||
      (b.kind === "list" && b.items.length === 0));
    expect(empty).toEqual([]);
  });

  it(`parses ${name} into a document, not a single blob`, () => {
    expect(blocks.length).toBeGreaterThan(40);
  });
});
