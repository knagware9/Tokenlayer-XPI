/**
 * THE EXPORT AN AUDITOR TAKES AWAY, and the cursor that decides whether they
 * saw everything.
 *
 * A CSV that shifts a column is worse than no CSV at all: the values still look
 * like values, just under the wrong headings, and nothing in the file says so.
 * Event payloads carry every character that does it — commas in JSON, quotes
 * and newlines in free-text revocation reasons — so the escaping is tested
 * against exactly those, not against tidy sample data.
 *
 * The cursor half matters for a different reason: the API returns YOUR OWN
 * cursor back on an empty page, so "no new rows" and "here is the next page"
 * are distinguished only by that equality. Read it wrong and the UI either
 * polls a quiet log forever or stops one page early and calls it the end.
 */
import { describe, expect, it } from "vitest";
import { activityCsv, atEnd, csvField } from "../src/lib/activity-log.js";
import type { PlatformEvent } from "../src/types.js";

const event = (over: Partial<PlatformEvent> = {}): PlatformEvent => ({
  seq: 1, id: "evt_1", type: "asset.issued", orgId: "org_1", useCaseKey: "gold-egr",
  subjectId: "asset_1", data: {}, occurredAt: "2026-08-13T10:00:00.000Z", ...over,
});

describe("csvField — the characters that corrupt a row", () => {
  it("leaves an ordinary value unquoted", () => {
    expect(csvField("asset.issued")).toBe("asset.issued");
    expect(csvField(42)).toBe("42");
  });

  it("quotes a value containing a comma", () => {
    expect(csvField("Mumbai, India")).toBe('"Mumbai, India"');
  });

  it("DOUBLES an embedded quote, per RFC 4180", () => {
    // The classic corruption: a single quote left as-is ends the field early
    // and every column after it shifts left.
    expect(csvField('he said "no"')).toBe('"he said ""no"""');
  });

  it("quotes a value containing a newline — a revocation reason can have one", () => {
    expect(csvField("line one\nline two")).toBe('"line one\nline two"');
    expect(csvField("carriage\rreturn")).toBe('"carriage\rreturn"');
  });

  it("renders null and undefined as empty, not as the words", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });

  it("JSON-encodes an object, then quotes it because JSON has commas", () => {
    expect(csvField({ a: 1, b: 2 })).toBe('"{""a"":1,""b"":2}"');
  });
});

describe("activityCsv", () => {
  it("writes the header even with no rows — an empty export is still a valid file", () => {
    expect(activityCsv([])).toBe("seq,occurredAt,type,orgId,useCaseKey,subjectId,id,data");
  });

  it("writes one line per event, in column order", () => {
    const csv = activityCsv([event({ seq: 7, id: "evt_7" })]);
    const [header, row] = csv.split("\n");
    expect(header!.split(",")).toEqual(["seq", "occurredAt", "type", "orgId", "useCaseKey", "subjectId", "id", "data"]);
    expect(row!.startsWith("7,2026-08-13T10:00:00.000Z,asset.issued,org_1,gold-egr,asset_1,evt_7,")).toBe(true);
  });

  it("survives a payload full of commas, quotes and newlines — and ROUND-TRIPS", () => {
    const payload = { reason: 'left, and said "bye"\nsigned', amount: "1,000" };
    const csv = activityCsv([event({ data: payload })]);
    const lines = csv.split("\n");

    // ONE physical line per event, even with a newline in the payload: `data`
    // is JSON-encoded first, and JSON escapes the newline to the two
    // characters \n before CSV ever sees it. Worth pinning — someone reading
    // only the CSV rules would expect the row to wrap here, and "fix" it.
    expect(lines).toHaveLength(2);
    expect(csv.match(/"/g)!.length % 2).toBe(0); // balanced quoting

    // The property that actually matters to an auditor: what comes out is what
    // went in. Undo the CSV quoting, then the JSON, and get the payload back.
    const cell = lines[1]!.slice(lines[1]!.indexOf(',{"') === -1 ? lines[1]!.indexOf(',"{') + 1 : 0);
    const unquoted = cell.startsWith('"') ? cell.slice(1, -1).replace(/""/g, '"') : cell;
    expect(JSON.parse(unquoted)).toEqual(payload);
  });

  it("leaves a null orgId and useCaseKey as empty cells", () => {
    const row = activityCsv([event({ orgId: null, useCaseKey: null, subjectId: null })]).split("\n")[1]!;
    expect(row).toContain(",,"); // adjacent empties, not "null"
    expect(row).not.toContain("null");
  });
});

describe("atEnd — have we reached the end of the log?", () => {
  it("an empty page is the end", () => {
    expect(atEnd(100, 100, 0)).toBe(true);
  });

  it("a cursor that did not advance is the end, even if rows came back", () => {
    // The API returns the caller's own cursor on an empty page; treating a
    // non-advancing cursor as "more" is how a UI loops forever.
    expect(atEnd(100, 100, 5)).toBe(true);
  });

  it("an advanced cursor with rows is NOT the end", () => {
    expect(atEnd(100, 150, 50)).toBe(false);
  });

  it("the first page from zero behaves the same way", () => {
    expect(atEnd(0, 0, 0)).toBe(true);
    expect(atEnd(0, 42, 42)).toBe(false);
  });
});
