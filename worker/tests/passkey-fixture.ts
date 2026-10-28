import { env } from "cloudflare:workers";
import { authRoute, type AuthEnv } from "../auth";
import { authEnv, cookies, mergeCookies, ORIGIN, request } from "./auth-fixture";

type CBOR = number | string | Uint8Array | Map<number | string, CBOR>;
const bytes = (...parts: Uint8Array[]) => {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  parts.reduce((offset, part) => (result.set(part, offset), offset + part.length), 0);
  return result;
};
const head = (major: number, n: number) => n < 24 ? new Uint8Array([major << 5 | n]) : n < 256 ? new Uint8Array([major << 5 | 24, n])
  : new Uint8Array([major << 5 | 25, n >> 8, n & 255]);
function cbor(value: CBOR): Uint8Array {
  if (typeof value === "number") return value < 0 ? head(1, -1 - value) : head(0, value);
  if (typeof value === "string") { const utf8 = new TextEncoder().encode(value); return bytes(head(3, utf8.length), utf8); }
  if (value instanceof Uint8Array) return bytes(head(2, value.length), value);
  return bytes(head(5, value.size), ...[...value].flatMap(([key, item]) => [cbor(key), cbor(item)]));
}
const b64url = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sha256 = async (value: Uint8Array | string) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", typeof value === "string" ? new TextEncoder().encode(value) : value));
const u32 = (n: number) => new Uint8Array([n >>> 24, n >>> 16 & 255, n >>> 8 & 255, n & 255]);

/** A software WebAuthn authenticator (Ed25519, "none" attestation) for real ceremonies in workerd. */
export interface Authenticator { id: Uint8Array; keys: CryptoKeyPair; counter: number }
export async function authenticator(): Promise<Authenticator> {
  return { id: crypto.getRandomValues(new Uint8Array(16)), counter: 0,
    keys: await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair };
}
const clientData = (type: string, challenge: string, origin: string) =>
  new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));

export async function attest(device: Authenticator, options: { challenge: string; rp: { id: string } }, origin: string) {
  const x = new Uint8Array(await crypto.subtle.exportKey("raw", device.keys.publicKey) as ArrayBuffer);
  const key = cbor(new Map<number, CBOR>([[1, 1], [3, -8], [-1, 6], [-2, x]]));
  const authData = bytes(await sha256(options.rp.id), new Uint8Array([0x45]), u32(device.counter),
    new Uint8Array(16), new Uint8Array([0, device.id.length]), device.id, key);
  const id = b64url(device.id);
  return { id, rawId: id, type: "public-key", authenticatorAttachment: "platform", clientExtensionResults: {},
    response: { clientDataJSON: b64url(clientData("webauthn.create", options.challenge, origin)), transports: ["internal"],
      attestationObject: b64url(cbor(new Map<string, CBOR>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]))) } };
}

export async function assertion(device: Authenticator, options: { challenge: string; rpId: string }, origin: string) {
  device.counter++;
  const authData = bytes(await sha256(options.rpId), new Uint8Array([0x05]), u32(device.counter));
  const data = clientData("webauthn.get", options.challenge, origin);
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", device.keys.privateKey, bytes(authData, await sha256(data))));
  const id = b64url(device.id);
  return { id, rawId: id, type: "public-key", authenticatorAttachment: "platform", clientExtensionResults: {},
    response: { clientDataJSON: b64url(data), authenticatorData: b64url(authData), signature: b64url(signature) } };
}

/** Browser state for one ceremony: the page origin, its cookies and, when signed in, its CSRF token. */
export interface Browser { origin?: string; cookie?: string; csrfToken?: string; env?: AuthEnv }

export async function registrationOptions(query: string, browser: Browser = {}) {
  const response = await authRoute(request(`/passkey/generate-register-options${query}`, undefined, browser.cookie, "", browser.origin ?? ORIGIN), browser.env ?? authEnv());
  return { response, cookie: mergeCookies(browser.cookie ?? "", cookies(response)) };
}

export async function register(device: Authenticator, query: string, browser: Browser = {},
  edit = (response: Awaited<ReturnType<typeof attest>>) => response as object) {
  const origin = browser.origin ?? ORIGIN, started = await registrationOptions(query, browser);
  if (started.response.status !== 200) return { options: started.response, verified: started.response, cookie: started.cookie };
  const response = edit(await attest(device, await started.response.json(), origin));
  const verified = await authRoute(request("/passkey/verify-registration", { response, ...(query ? { createSession: true } : {}) },
    started.cookie, browser.csrfToken, origin), browser.env ?? authEnv());
  return { options: started.response, verified, cookie: mergeCookies(started.cookie, cookies(verified)) };
}

export async function signIn(device: Authenticator, browser: Browser = {}) {
  const origin = browser.origin ?? ORIGIN, target = browser.env ?? authEnv();
  const options = await authRoute(request("/passkey/generate-authenticate-options", undefined, browser.cookie, "", origin), target);
  if (options.status !== 200) return { verified: options, cookie: browser.cookie ?? "" };
  const cookie = mergeCookies(browser.cookie ?? "", cookies(options));
  const verified = await authRoute(request("/passkey/verify-authentication", { response: await assertion(device, await options.json(), origin) },
    cookie, "", origin), target);
  return { verified, cookie: mergeCookies(cookie, cookies(verified)) };
}

export const count = async (table: string) => Number((await env.DB.prepare(`SELECT count(*) n FROM ${table}`).first())!.n);
