import { describe, expect, it } from "vitest";
import { assertDeliverableUrl, checkUrl } from "../src/webhooks/url-guard.js";

/** Deterministic resolver stub — the guard never does real DNS in tests. */
const resolvesTo = (map: Record<string, string[]>) => async (host: string) => map[host] ?? [];

describe("webhook URL guard", () => {
  const publicDns = resolvesTo({ "hooks.example.com": ["93.184.216.34"] });

  it("accepts a public HTTPS URL", async () => {
    await expect(assertDeliverableUrl("https://hooks.example.com/x", { resolve: publicDns })).resolves.toBeUndefined();
  });

  for (const [label, url] of [
    ["cloud metadata by literal IP", "https://169.254.169.254/latest/meta-data/"],
    ["loopback by literal IP", "https://127.0.0.1/hook"],
    ["IPv6 loopback", "https://[::1]/hook"],
    ["private 10/8", "https://10.0.0.5/hook"],
    ["private 172.16/12", "https://172.16.3.4/hook"],
    ["private 192.168/16", "https://192.168.1.10/hook"],
    ["CGNAT 100.64/10", "https://100.64.0.1/hook"],
    ["plain HTTP to a public host", "http://hooks.example.com/x"],
    ["credentials in the URL", "https://user:pass@hooks.example.com/x"],
    ["a non-HTTP scheme", "file:///etc/passwd"],
  ] as const) {
    it(`rejects ${label}`, async () => {
      await expect(assertDeliverableUrl(url, { resolve: publicDns })).rejects.toThrow();
    });
  }

  it("rejects a public NAME that resolves to a private address", async () => {
    const rebind = resolvesTo({ "evil.example.com": ["10.1.2.3"] });
    await expect(assertDeliverableUrl("https://evil.example.com/x", { resolve: rebind })).rejects.toThrow(/private|not publicly routable/i);
  });

  it("THE REBINDING CASE: public at registration, private at delivery", async () => {
    const atRegistration = resolvesTo({ "flip.example.com": ["93.184.216.34"] });
    const atDelivery = resolvesTo({ "flip.example.com": ["127.0.0.1"] });
    await expect(assertDeliverableUrl("https://flip.example.com/x", { resolve: atRegistration })).resolves.toBeUndefined();
    // The SAME url must be rejected when checked again at delivery time. This is
    // the whole reason the guard runs twice rather than only on registration.
    await expect(assertDeliverableUrl("https://flip.example.com/x", { resolve: atDelivery })).rejects.toThrow(/loopback/i);
  });

  it("rejects a name resolving to one public AND one private address", async () => {
    // The client picks one of the answers and we do not get to say which, so
    // "some address is fine" is not a policy — every address must be fine.
    const mixed = resolvesTo({ "half.example.com": ["93.184.216.34", "169.254.169.254"] });
    await expect(assertDeliverableUrl("https://half.example.com/x", { resolve: mixed })).rejects.toThrow(/169\.254\.169\.254/);
  });

  it("rejects a host that does not resolve at all", async () => {
    await expect(assertDeliverableUrl("https://nowhere.example.com/x", { resolve: publicDns })).rejects.toThrow(/does not resolve/i);
  });

  it("rejects a resolver that throws, rather than propagating a raw DNS error", async () => {
    const broken = async () => { throw new Error("EAI_AGAIN"); };
    await expect(assertDeliverableUrl("https://oops.example.com/x", { resolve: broken })).rejects.toThrow(/does not resolve/i);
  });

  it("rejects a string that is not an absolute URL", async () => {
    const r = await checkUrl("/relative/path", { resolve: publicDns });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/absolute URL/i);
  });

  it("judges IPv6 by its BYTES, not by how it is spelled", async () => {
    // ::ffff:7f00:1 IS ::ffff:127.0.0.1 — a mapped-v4 check that looks for a
    // dotted tail waves this straight through to loopback. Likewise fe80::/10
    // spans fe80–febf, so a startsWith("fe80") test misses fe93::1.
    for (const url of [
      "https://[::ffff:7f00:1]/hook", // mapped loopback, hex notation
      "https://[::ffff:169.254.169.254]/hook", // mapped cloud metadata
      "https://[::ffff:a00:5]/hook", // mapped 10.0.0.5
      "https://[64:ff9b::7f00:1]/hook", // NAT64-embedded loopback
      "https://[fe93::1]/hook", // link-local above the fe80 prefix
      "https://[fd12:3456::1]/hook", // unique-local
      "https://[::]/hook", // unspecified
      "https://[ff02::1]/hook", // multicast
    ]) {
      await expect(assertDeliverableUrl(url, { resolve: publicDns }), url).rejects.toThrow();
    }
  });

  it("still accepts a genuinely public IPv6 address", async () => {
    await expect(assertDeliverableUrl("https://[2606:2800:220:1:248:1893:25c8:1946]/x", { resolve: publicDns })).resolves.toBeUndefined();
  });

  it("accepts a public IPv4 literal and a decimal-encoded loopback is still loopback", async () => {
    await expect(assertDeliverableUrl("https://93.184.216.34/x", { resolve: publicDns })).resolves.toBeUndefined();
    // WHATWG URL normalises 2130706433 to 127.0.0.1 before we ever see it.
    await expect(assertDeliverableUrl("https://2130706433/x", { resolve: publicDns })).rejects.toThrow(/loopback/i);
  });

  it("allows http to loopback ONLY when explicitly opted in (dev/test)", async () => {
    const loop = resolvesTo({ localhost: ["127.0.0.1"] });
    await expect(assertDeliverableUrl("http://localhost:9931/hook", { resolve: loop })).rejects.toThrow();
    await expect(assertDeliverableUrl("http://localhost:9931/hook", { resolve: loop, allowInsecureLoopback: true })).resolves.toBeUndefined();
  });

  it("the loopback opt-in does NOT open up other private ranges", async () => {
    // The dev escape hatch is for a hook server on this machine, not a licence
    // to reach the operator's LAN or the cloud metadata service.
    const opts = { resolve: publicDns, allowInsecureLoopback: true };
    await expect(assertDeliverableUrl("http://10.0.0.5/hook", opts)).rejects.toThrow(/private 10\/8/);
    await expect(assertDeliverableUrl("http://169.254.169.254/latest/meta-data/", opts)).rejects.toThrow(/metadata/i);
  });

  it("checkUrl reports a reason instead of throwing", async () => {
    const r = await checkUrl("https://127.0.0.1/x", { resolve: publicDns });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/loopback/i);
  });
});
