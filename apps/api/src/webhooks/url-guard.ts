/**
 * SSRF guard (EN-C). A webhook URL is the first place an ORG-SUPPLIED string
 * tells this server where to send a request FROM INSIDE THE NETWORK. Unguarded,
 * an OrgAdmin points an endpoint at 169.254.169.254 (cloud metadata) or
 * localhost:8545 (the operator's own Besu node) and the API becomes their proxy.
 *
 * Run at REGISTRATION and AGAIN immediately before EVERY delivery attempt.
 * Checking only at registration is defeated by DNS rebinding: a name that
 * resolved publicly when it was saved can resolve to 127.0.0.1 an hour later.
 * The rebinding test in webhooks-url-guard.test.ts pins that behaviour.
 *
 * Pure by construction — the resolver is injected, so the whole policy is
 * testable without DNS or HTTP.
 *
 * WHAT THIS MODULE CANNOT DO, and what the dispatcher (C5) therefore must:
 *  - REDIRECTS. A public URL that answers 302 Location: http://169.254.169.254/
 *    walks straight past a guard that only ever sees the registered URL. The
 *    HTTP client must not follow redirects (or must re-run this guard on every
 *    hop).
 *  - THE RESIDUAL TOCTOU RACE. Even checked immediately before the request, the
 *    HTTP client performs its OWN resolution, so a sufficiently fast attacker
 *    can still flip the answer in between. Closing it completely means pinning
 *    the address we validated and connecting to that, which is a client-level
 *    concern. Re-checking shrinks the window from hours to milliseconds; it does
 *    not remove it.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type Resolver = (host: string) => Promise<string[]>;

export interface UrlGuardOptions {
  resolve?: Resolver;
  /** Dev/test only: permits http:// to a loopback address. */
  allowInsecureLoopback?: boolean;
}

export type UrlVerdict = { ok: true } | { ok: false; reason: string };

const realResolve: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

const LOOPBACK_REASONS = new Set(["loopback", "IPv6 loopback"]);

/**
 * A valid IPv6 literal as its 16 bytes, or null if it will not parse.
 *
 * Prefix STRING matching on IPv6 is not sufficient and this is a real bypass,
 * not pedantry: `fe80::/10` spans fe80–febf, so a `startsWith("fe80")` test
 * misses fe93::1, and `::ffff:7f00:1` is the very same address as
 * `::ffff:127.0.0.1` written without a dotted tail — a regex looking for dots
 * would wave it through to 127.0.0.1. Comparing bytes makes the notation
 * irrelevant, which is the only way to be sure two spellings of one address get
 * one answer.
 */
function ipv6ToBytes(addr: string): Uint8Array | null {
  let s = addr.split("%")[0]!.toLowerCase(); // drop any zone id (fe80::1%eth0)

  // A trailing dotted quad (::ffff:127.0.0.1, 64:ff9b::203.0.113.1) is just two
  // more 16-bit groups — rewrite it so the group parser below sees one grammar.
  if (s.includes(".")) {
    const colon = s.lastIndexOf(":");
    const quad = s.slice(colon + 1).split(".").map(Number);
    if (quad.length !== 4 || quad.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    s = `${s.slice(0, colon + 1)}${((quad[0]! << 8) | quad[1]!).toString(16)}:${((quad[2]! << 8) | quad[3]!).toString(16)}`;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;
  if (tail === null && head.length !== 8) return null; // uncompressed must be full
  if (head.length + (tail?.length ?? 0) > 8) return null;

  const out = new Uint8Array(16);
  const put = (groups: string[], at: number): boolean => {
    for (let i = 0; i < groups.length; i += 1) {
      const g = groups[i]!;
      if (!/^[0-9a-f]{1,4}$/.test(g)) return false;
      const n = parseInt(g, 16);
      out[at + i * 2] = n >> 8;
      out[at + i * 2 + 1] = n & 0xff;
    }
    return true;
  };
  if (!put(head, 0)) return null;
  if (tail && !put(tail, 16 - tail.length * 2)) return null;
  return out;
}

/** Every range an integrator endpoint has no business being in. */
function blockedReason(ip: string): string | null {
  const v = isIP(ip);
  if (v === 6) {
    const b = ipv6ToBytes(ip);
    if (!b) return "unparseable IPv6 address"; // fail closed: never guess
    if (b.every((x) => x === 0)) return "unspecified address";
    if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return "IPv6 loopback";
    if (b[0] === 0xff) return "IPv6 multicast";
    if ((b[0]! & 0xfe) === 0xfc) return "IPv6 unique-local"; // fc00::/7
    if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return "IPv6 link-local"; // fe80::/10
    // Any wrapper carrying a v4 address — ::ffff:a.b.c.d (mapped), ::a.b.c.d
    // (deprecated compatible) and 64:ff9b::a.b.c.d (NAT64) — is judged on the
    // EMBEDDED v4, which is the address packets actually reach.
    const zero10 = b.slice(0, 10).every((x) => x === 0);
    const mapped = zero10 && b[10] === 0xff && b[11] === 0xff;
    const compatible = zero10 && b[10] === 0 && b[11] === 0;
    const nat64 = b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0);
    if (mapped || compatible || nat64) return blockedReason(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
    return null;
  }
  if (v !== 4) return "not an IP address";
  const [a, b] = ip.split(".").map(Number) as [number, number, number, number];
  if (a === 0) return "unspecified network";
  if (a === 127) return "loopback";
  if (a === 10) return "private 10/8";
  if (a === 172 && b >= 16 && b <= 31) return "private 172.16/12";
  if (a === 192 && b === 168) return "private 192.168/16";
  if (a === 169 && b === 254) return "link-local / cloud metadata";
  if (a === 100 && b >= 64 && b <= 127) return "carrier-grade NAT 100.64/10";
  if (a >= 224) return "multicast or reserved";
  return null;
}

export async function checkUrl(raw: string, opts: UrlGuardOptions = {}): Promise<UrlVerdict> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid absolute URL" };
  }

  // Credentials in the URL would be sent to whatever the host resolves to, and
  // would sit in the endpoint row in the clear for anyone with read access.
  if (u.username || u.password) return { ok: false, reason: "credentials in the URL are not allowed" };
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: `unsupported scheme '${u.protocol}'` };

  const host = u.hostname.replace(/^\[|\]$/g, "");
  const resolve = opts.resolve ?? realResolve;
  // A literal IP needs no resolution — and must not get one, or a resolver stub
  // returning [] would turn "https://127.0.0.1" into "does not resolve".
  let addrs: string[];
  if (isIP(host)) {
    addrs = [host];
  } else {
    try {
      addrs = await resolve(host);
    } catch {
      return { ok: false, reason: `host '${host}' does not resolve` };
    }
  }
  if (addrs.length === 0) return { ok: false, reason: `host '${host}' does not resolve` };

  // EVERY resolved address must be acceptable. A name resolving to one public
  // and one private address is a rebinding attempt, not a valid endpoint: the
  // client picks one of the answers and we do not get to say which.
  for (const ip of addrs) {
    const bad = blockedReason(ip);
    if (bad) {
      const loopbackOk = opts.allowInsecureLoopback === true && LOOPBACK_REASONS.has(bad);
      if (!loopbackOk) return { ok: false, reason: `${ip} is ${bad} — not publicly routable` };
    }
  }

  if (u.protocol === "http:") {
    // Plaintext delivery leaks the payload AND the signature to anyone on the
    // path, so http is only ever tolerable when it cannot leave the machine.
    const allLoopback = addrs.every((ip) => LOOPBACK_REASONS.has(blockedReason(ip) ?? ""));
    if (!(opts.allowInsecureLoopback === true && allLoopback)) {
      return { ok: false, reason: "webhook URLs must use https" };
    }
  }
  return { ok: true };
}

export async function assertDeliverableUrl(raw: string, opts: UrlGuardOptions = {}): Promise<void> {
  const v = await checkUrl(raw, opts);
  if (!v.ok) throw new Error(v.reason);
}
