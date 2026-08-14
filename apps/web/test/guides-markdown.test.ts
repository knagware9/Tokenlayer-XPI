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
import { parseMarkdown } from "../src/components/shared/Guides.js";
import issueACredential from "../../../docs/api/guides/issue-a-credential.md?raw";
import receiveWebhooks from "../../../docs/api/guides/receive-webhooks.md?raw";
import tokenizeAnAsset from "../../../docs/api/guides/tokenize-an-asset.md?raw";

const GUIDES = [
  ["issue-a-credential", issueACredential],
  ["receive-webhooks", receiveWebhooks],
  ["tokenize-an-asset", tokenizeAnAsset],
] as const;

/**
 * Walk the source once, counting only what is OUTSIDE a fenced block.
 *
 * THE COUNTER AND THE PARSER MUST AGREE ON WHAT A LIST ITEM IS. They did not:
 * this matched `- ` at column 0 while `parseMarkdown` matches it after
 * `trimStart()`, so the first nested bullet anyone wrote —
 *
 *     - top
 *       - nested
 *
 * — would be one item to the counter and two to the parser, and "keeps every
 * list item" would fail on correct markdown. The guides were just rewritten
 * against a live run and will be edited again; a guard that fires on ordinary
 * authoring is a guard that gets deleted. The parser is the definition here, so
 * the counter follows it: indentation does not decide whether a line is a list
 * item (`markdownIndentAgreement` below pins that both ways).
 *
 * Headings and table dividers are deliberately left as they were — the parser
 * reads headings at column 0 too, and trims before testing a divider, so those
 * two already agree.
 */
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
    if (/^([-*]\s|\d+\.\s)/.test(line.trimStart())) items++;
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

/**
 * The counter above is only an oracle if it means the same thing as the parser.
 * The three guides do not currently contain a nested list, so the disagreement
 * that made this fix necessary is invisible against them — it would have
 * appeared on the next edit, as a failing test on markdown that was correct.
 * These fixtures make the property hold on the input that exposes it.
 */
describe("markdownIndentAgreement", () => {
  const items = (source: string): number =>
    parseMarkdown(source).reduce((n, b) => n + (b.kind === "list" ? b.items.length : 0), 0);

  it.each([
    ["a nested bullet", "Intro.\n\n- top\n  - nested\n  - also nested\n- second top\n"],
    ["a deeply nested bullet", "- a\n  - b\n    - c\n"],
    ["a nested ordered item under a bullet", "- top\n  1. one\n  2. two\n"],
    ["an indented list with no parent", "Text.\n\n  - indented\n  - twice\n"],
    ["a flat list, unchanged", "- a\n- b\n\n1. one\n2. two\n"],
    ["a list item shape inside a fence", "- real\n\n```bash\n- not a list item\n1. nor this\n```\n"],
  ])("counts %s the same way the parser does", (_name, source) => {
    expect(items(source)).toBe(expectedCounts(source).items);
  });

  it("actually sees the nested items, rather than agreeing on zero", () => {
    // Guards the mutation "make both sides return 0": two broken halves that
    // cancel out would satisfy every case above.
    expect(items("- top\n  - nested\n  - also nested\n- second top\n")).toBe(4);
    expect(expectedCounts("- top\n  - nested\n").items).toBe(2);
  });
});
