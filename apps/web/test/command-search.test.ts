import { describe, expect, it } from "vitest";
import { rankCommandResults, type CommandItem } from "../src/lib/shared/command-search.js";

function item(id: string, label: string, sublabel?: string): CommandItem {
  return { id, label, sublabel, kind: "use-case", onSelect: () => undefined };
}

describe("rankCommandResults", () => {
  it("returns everything, unranked, for an empty query", () => {
    const items = [item("a", "Alpha"), item("b", "Beta")];
    expect(rankCommandResults("", items)).toEqual(items);
  });

  it("filters out items that match neither label nor sublabel", () => {
    const items = [item("a", "Bamboo Plot"), item("b", "Turmeric Plot")];
    expect(rankCommandResults("bamboo", items).map((i) => i.id)).toEqual(["a"]);
  });

  it("ranks a prefix match on label above a mid-string match", () => {
    const items = [item("a", "Bamboo Plot"), item("b", "Wayanad Bamboo Fund")];
    const ranked = rankCommandResults("bamboo", items);
    expect(ranked.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("is case-insensitive", () => {
    const items = [item("a", "REDD+ Forest Conservation")];
    expect(rankCommandResults("redd", items).map((i) => i.id)).toEqual(["a"]);
    expect(rankCommandResults("REDD", items).map((i) => i.id)).toEqual(["a"]);
  });

  it("matches on sublabel too, ranked below any label match", () => {
    const items = [item("a", "Dairy Cattle Digital Twin", "DCOW"), item("b", "DCOW Loan Program")];
    const ranked = rankCommandResults("dcow", items);
    expect(ranked.map((i) => i.id)).toEqual(["b", "a"]);
  });

  it("caps results at 20", () => {
    const items = Array.from({ length: 30 }, (_, i) => item(String(i), `Match ${i}`));
    expect(rankCommandResults("match", items)).toHaveLength(20);
  });

  it("returns an empty array, never throws, for a query matching nothing", () => {
    const items = [item("a", "Alpha")];
    expect(() => rankCommandResults("zzz-nonexistent", items)).not.toThrow();
    expect(rankCommandResults("zzz-nonexistent", items)).toEqual([]);
  });
});
