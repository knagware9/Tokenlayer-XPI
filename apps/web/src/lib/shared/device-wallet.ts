import * as ed from "@noble/ed25519";

const PRIV_KEY = "tokenlayer.deviceKey"; // hex-encoded 32-byte private key (self-custody; never sent)
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let out = ""; while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = "1" + out; else break; }
  return out;
}
const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string): Uint8Array => new Uint8Array((h.match(/.{2}/g) ?? []).map((x) => parseInt(x, 16)));
const b64u = (b: Uint8Array): string => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function didKeyFromPub(pub: Uint8Array): string {
  const prefixed = new Uint8Array(pub.length + 2); prefixed[0] = 0xed; prefixed[1] = 0x01; prefixed.set(pub, 2);
  return "did:key:z" + base58(prefixed);
}

export function hasDeviceKey(): boolean { return !!localStorage.getItem(PRIV_KEY); }

/** Return (creating + persisting if needed) this device's self-custody key. */
export async function getOrCreateDeviceKey(): Promise<{ did: string; sign: (msg: string) => Promise<string> }> {
  let hex = localStorage.getItem(PRIV_KEY);
  if (!hex) { hex = toHex(ed.utils.randomPrivateKey()); localStorage.setItem(PRIV_KEY, hex); }
  const priv = fromHex(hex);
  const pub = await ed.getPublicKeyAsync(priv);
  return {
    did: didKeyFromPub(pub),
    sign: async (msg: string) => b64u(await ed.signAsync(new TextEncoder().encode(msg), priv)),
  };
}
