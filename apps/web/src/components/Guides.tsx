/**
 * EN-D1 (task D1-6): the three integration guides, in the console.
 *
 * ═══ ONE SOURCE OF TRUTH, AND WHY IT IS THE `docs/` COPY ═══
 *
 * The markdown is IMPORTED from `docs/api/guides/*.md` with Vite's `?raw`
 * suffix. It is not transcribed here, and it must never be: task D1-7 verifies
 * those files by EXECUTING them against a live deployment and correcting
 * whatever diverges. A pasted copy in a TSX file would not be executed, would
 * not be corrected, and would go on confidently telling integrators whatever
 * was true on the day it was pasted — which is precisely the failure mode
 * EN-D1 exists to end, one layer up from the OpenAPI document.
 *
 * The import reaches OUTSIDE apps/web, up to the repo root. That works for both
 * the dev server and the build: Vite's `server.fs` allow-list defaults to the
 * workspace root (found via `pnpm-workspace.yaml`), and the build resolves the
 * path through Rollup like any other module. If it ever stops working the fix
 * is `server.fs.allow`, NOT a copy of the markdown.
 *
 * ═══ WHY THERE IS A RENDERER HERE AND NOT A DEPENDENCY ═══
 *
 * These are three known documents, not arbitrary user input. They use headings,
 * paragraphs, lists, tables, blockquotes, rules, inline code/bold/emphasis and
 * fenced code blocks — and nothing else, which is checked by reading them
 * rather than assumed. A markdown library would be a new runtime dependency,
 * and (for the ones that take HTML) a new sanitisation question, in exchange
 * for constructs these files do not contain. If a future guide needs footnotes
 * or embedded HTML, add the library then and say so.
 */
import { useMemo, useState } from "react";
import issueACredential from "../../../../docs/api/guides/issue-a-credential.md?raw";
import receiveWebhooks from "../../../../docs/api/guides/receive-webhooks.md?raw";
import tokenizeAnAsset from "../../../../docs/api/guides/tokenize-an-asset.md?raw";
import { Card, CopyBlock } from "./ui.js";

interface Guide { id: string; title: string; blurb: string; source: string }

const GUIDES: Guide[] = [
  {
    id: "tokenize-an-asset",
    title: "Tokenize an asset",
    blurb: "Configure a use case, mint on chain, transfer, and read back who holds what.",
    source: tokenizeAnAsset,
  },
  {
    id: "issue-a-credential",
    title: "Issue a credential",
    blurb: "Issue a verifiable credential, get it accepted, and prove to a third party that it is real.",
    source: issueACredential,
  },
  {
    id: "receive-webhooks",
    title: "Receive webhooks",
    blurb: "Register an endpoint, verify signatures, and survive duplicate or out-of-order deliveries.",
    source: receiveWebhooks,
  },
];

export function Guides(): JSX.Element {
  const [openId, setOpenId] = useState<string>(GUIDES[0]?.id ?? "");
  const guide = GUIDES.find((g) => g.id === openId) ?? GUIDES[0];

  return (
    <div className="space-y-4">
      <Card
        title="Integration guides"
        description="End-to-end walkthroughs, rendered from the same markdown files that live in the repository under docs/api/guides — there is no second copy to drift."
      >
        <div className="flex flex-wrap gap-2">
          {GUIDES.map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => setOpenId(g.id)}
              className={`rounded-lg border px-3 py-2 text-left text-xs max-w-xs ${
                g.id === openId
                  ? "border-brand-500 bg-brand-50 text-brand-800"
                  : "border-slate-200 text-slate-600 hover:bg-slate-50"
              }`}
            >
              <span className="block font-semibold">{g.title}</span>
              <span className="block text-slate-500 mt-0.5">{g.blurb}</span>
            </button>
          ))}
        </div>
      </Card>

      {guide && (
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6">
          <Markdown key={guide.id} source={guide.source} />
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────── the compact renderer ──────────────────────── */

/**
 * A markdown block. Parsing to a block list first (rather than emitting JSX as
 * we scan) is what makes fenced code safe: everything between the fences is
 * captured verbatim in one pass, so a `#`, a `|` or a `**` inside a shell
 * snippet can never be mistaken for a heading, a table row or bold text.
 */
type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; language: string; code: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "quote"; text: string }
  | { kind: "rule" };

const FENCE = /^```\s*([A-Za-z0-9+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const UNORDERED = /^[-*]\s+(.*)$/;
const ORDERED = /^\d+\.\s+(.*)$/;
const TABLE_DIVIDER = /^\|[\s:|-]+\|$/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.trim() === "") { i++; continue; }

    // Fenced code FIRST — see the Block comment above.
    const fence = FENCE.exec(line.trim());
    if (fence) {
      const language = fence[1] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test((lines[i] ?? "").trim())) { body.push(lines[i] ?? ""); i++; }
      i++; // consume the closing fence (or fall off the end on an unterminated block)
      blocks.push({ kind: "code", language, code: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]?.length ?? 1, text: heading[2] ?? "" });
      i++;
      continue;
    }

    // A horizontal rule. Checked after the table divider shape below can no
    // longer match, because `|---|---|` also contains dashes.
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { blocks.push({ kind: "rule" }); i++; continue; }

    if (line.trimStart().startsWith(">")) {
      const parts: string[] = [];
      while (i < lines.length && (lines[i] ?? "").trimStart().startsWith(">")) {
        parts.push((lines[i] ?? "").replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push({ kind: "quote", text: parts.join(" ").trim() });
      continue;
    }

    // Table: a pipe row followed by a `|---|---|` divider. Without the divider
    // it is just a paragraph that happens to contain pipes.
    if (line.trimStart().startsWith("|") && TABLE_DIVIDER.test((lines[i + 1] ?? "").trim())) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").trimStart().startsWith("|")) {
        rows.push(splitRow(lines[i] ?? ""));
        i++;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    const listMatch = UNORDERED.exec(line.trimStart()) ?? ORDERED.exec(line.trimStart());
    if (listMatch) {
      const ordered = ORDERED.test(line.trimStart());
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i] ?? "";
        const start = ordered ? ORDERED.exec(current.trimStart()) : UNORDERED.exec(current.trimStart());
        if (start) {
          items.push(start[1] ?? "");
          i++;
          // A wrapped item continues on the following indented lines. Folding
          // them into the item (rather than starting a paragraph) is what keeps
          // a two-line bullet from splitting mid-sentence.
          while (i < lines.length && /^\s+\S/.test(lines[i] ?? "") && !FENCE.test((lines[i] ?? "").trim())) {
            const continuation = (lines[i] ?? "").trim();
            if (UNORDERED.test(continuation) || ORDERED.test(continuation)) break;
            items[items.length - 1] = `${items[items.length - 1]} ${continuation}`;
            i++;
          }
          continue;
        }
        break;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    // Paragraph: run to the next blank line or the start of another block.
    const parts: string[] = [];
    while (i < lines.length) {
      const current = lines[i] ?? "";
      if (current.trim() === "") break;
      const trimmed = current.trimStart();
      if (FENCE.test(trimmed) || HEADING.test(current) || trimmed.startsWith(">") || trimmed.startsWith("|")) break;
      if (UNORDERED.test(trimmed) || ORDERED.test(trimmed)) break;
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(current.trim())) break;
      parts.push(current.trim());
      i++;
    }
    if (parts.length > 0) blocks.push({ kind: "paragraph", text: parts.join(" ") });
    else i++; // nothing consumed — never loop forever on an unrecognised line
  }

  return blocks;
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function Markdown({ source }: { source: string }): JSX.Element {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <article className="max-w-3xl space-y-3">
      {blocks.map((block, i) => <BlockView key={i} block={block} />)}
    </article>
  );
}

const HEADING_CLASS: Record<number, string> = {
  1: "text-xl font-bold text-slate-900 mt-2",
  2: "text-base font-semibold text-slate-900 mt-6 pt-4 border-t border-slate-100",
  3: "text-sm font-semibold text-slate-900 mt-4",
  4: "text-sm font-semibold text-slate-700 mt-3",
  5: "text-xs font-semibold text-slate-700 mt-3",
  6: "text-xs font-semibold text-slate-600 mt-3",
};

function BlockView({ block }: { block: Block }): JSX.Element | null {
  switch (block.kind) {
    case "heading": {
      const Tag = (`h${Math.min(block.level + 1, 6)}`) as "h2" | "h3" | "h4" | "h5" | "h6";
      return <Tag className={HEADING_CLASS[block.level] ?? HEADING_CLASS[3]}>{inline(block.text)}</Tag>;
    }
    case "paragraph":
      return <p className="text-sm text-slate-600 leading-6">{inline(block.text)}</p>;
    case "code":
      // Every fenced block gets a copy button — these guides are made of
      // commands, and a command copied by hand is a command with a stray
      // character in it.
      return <CopyBlock code={block.code} language={block.language || undefined} className="my-3" />;
    case "rule":
      return <hr className="border-slate-200" />;
    case "quote":
      return (
        <blockquote className="border-l-4 border-amber-300 bg-amber-50 pl-3 py-2 text-sm text-slate-700">
          {inline(block.text)}
        </blockquote>
      );
    case "list":
      return block.ordered ? (
        <ol className="list-decimal pl-5 space-y-1.5 text-sm text-slate-600 leading-6">
          {block.items.map((item, i) => <li key={i}>{inline(item)}</li>)}
        </ol>
      ) : (
        <ul className="list-disc pl-5 space-y-1.5 text-sm text-slate-600 leading-6">
          {block.items.map((item, i) => <li key={i}>{inline(item)}</li>)}
        </ul>
      );
    case "table":
      return (
        <div className="overflow-x-auto">
          <table className="text-xs border border-slate-200 rounded-lg">
            <thead className="bg-slate-50 text-slate-500 uppercase tracking-wide">
              <tr>{block.header.map((cell, i) => <th key={i} className="text-left font-medium px-3 py-2 border-b border-slate-200">{inline(cell)}</th>)}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r} className="border-b border-slate-100 last:border-b-0 align-top">
                  {row.map((cell, c) => <td key={c} className="px-3 py-1.5 text-slate-600">{inline(cell)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/**
 * Inline markdown, as a recursive scanner rather than a chain of replacements.
 *
 * Recursion is what makes `**\`201\`**` — bold wrapping code, which these guides
 * use constantly — come out right. Splitting on code spans first would strip the
 * code out and leave the `**` markers stranded as literal asterisks.
 */
function inline(text: string, depth = 0): (string | JSX.Element)[] {
  const out: (string | JSX.Element)[] = [];
  if (depth > 4) return [text];
  let buffer = "";
  let key = 0;
  let i = 0;

  const flush = (): void => { if (buffer !== "") { out.push(buffer); buffer = ""; } };

  while (i < text.length) {
    const rest = text.slice(i);

    const code = /^`([^`]+)`/.exec(rest);
    if (code) {
      flush();
      out.push(<code key={key++} className="font-mono text-[0.9em] bg-slate-100 text-slate-800 rounded px-1 py-0.5">{code[1]}</code>);
      i += code[0].length;
      continue;
    }

    const bold = /^\*\*([\s\S]+?)\*\*/.exec(rest);
    if (bold) {
      flush();
      out.push(<strong key={key++} className="font-semibold text-slate-800">{inline(bold[1] ?? "", depth + 1)}</strong>);
      i += bold[0].length;
      continue;
    }

    const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
    if (link) {
      flush();
      const href = safeHref(link[2] ?? "");
      out.push(
        href
          ? <a key={key++} href={href} target="_blank" rel="noreferrer noopener" className="text-brand-700 underline">{inline(link[1] ?? "", depth + 1)}</a>
          // A scheme we will not render is shown as its text plus the raw
          // target, so nothing is silently dropped from the document.
          : <span key={key++}>{link[1]} ({link[2]})</span>,
      );
      i += link[0].length;
      continue;
    }

    const em = /^(?:\*([^*\n]+)\*|_([^_\n]+)_)/.exec(rest);
    if (em) {
      flush();
      out.push(<em key={key++}>{inline(em[1] ?? em[2] ?? "", depth + 1)}</em>);
      i += em[0].length;
      continue;
    }

    buffer += text[i];
    i++;
  }
  flush();
  return out;
}

/** Only http(s), mailto and same-document anchors get to be links. These guides
 * contain no links at all today, so this is a guard against what a future edit
 * might add rather than against anything present. */
function safeHref(href: string): string | null {
  const value = href.trim();
  if (/^(https?:|mailto:)/i.test(value)) return value;
  if (value.startsWith("#") || value.startsWith("/")) return value;
  return null;
}
