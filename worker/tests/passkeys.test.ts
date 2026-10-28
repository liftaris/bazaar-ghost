import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { authRoute, authenticated } from "../auth";
import { authEnv, complete, login, mockProviders, ORIGIN, request, start } from "./auth-fixture";
import { attest, authenticator, count, register, registrationOptions, signIn } from "./passkey-fixture";

const FRONTEND = "https://frontend-validation.example.org";
const split = () => ({ ...authEnv(), CORS_ORIGINS: `${ORIGIN},${FRONTEND}` });
const signUp = async (name = "Kaio") => {
  const device = await authenticator(), result = await register(device, `?context=${encodeURIComponent(name)}`);
  expect(result.verified.status).toBe(200);
  return { device, cookie: result.cookie, identity: await authenticated(request("/session", undefined, result.cookie), authEnv()) };
};
const withOrigin = (origin: string) => (response: { response: { clientDataJSON: string } }) => {
  const data = JSON.parse(atob(response.response.clientDataJSON.replace(/-/g, "+").replace(/_/g, "/")));
  const clientDataJSON = btoa(JSON.stringify({ ...data, origin })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { ...response, response: { ...response.response, clientDataJSON } };
};
afterEach(async () => {
  vi.unstubAllGlobals();
  await env.DB.exec("DROP TRIGGER IF EXISTS fail_passkey_insert");
});

it("issues registration options without a session or any user row", async () => {
  const { response } = await registrationOptions("?context=%20Kaio%20");
  expect(response.status).toBe(200);
  const options = await response.json() as { rp: { id: string; name: string }; user: { name: string; displayName: string } };
  expect(options.rp).toEqual({ id: new URL(ORIGIN).hostname, name: "BazaarGhost" });
  expect(options.user).toMatchObject({ name: "Kaio", displayName: "Kaio" });
  expect(await count("app_users")).toBe(0);
});

it("creates an active passkey-only user only after the ceremony verifies, without leaking secrets", async () => {
  const device = await authenticator(), result = await register(device, "?context=Kaio");
  expect(await result.verified.json()).toEqual({ ok: true });
  expect(result.verified.headers.getSetCookie().some(value => value.startsWith("__Host-bazaarghost_session="))).toBe(true);
  const user = await env.DB.prepare("SELECT name,status,registeredAt,email FROM app_users").first<{ name: string; status: string; registeredAt: number; email: string }>();
  expect(user).toMatchObject({ name: "Kaio", status: "active" });
  expect(user!.registeredAt).toBeGreaterThan(0);
  expect(user!.email).toMatch(/@passkey\.bazaarghost\.invalid$/);
  expect(await count("user_passkeys")).toBe(1); expect(await count("user_accounts")).toBe(0);
  const identity = await authenticated(request("/session", undefined, result.cookie), authEnv());
  expect(identity.name).toBe("Kaio");
  const listed = await (await authRoute(request("/passkeys", undefined, result.cookie), authEnv())).text();
  const stored = await env.DB.prepare("SELECT publicKey,credentialID FROM user_passkeys").first<{ publicKey: string; credentialID: string }>();
  expect(listed).not.toContain(stored!.publicKey); expect(listed).not.toContain(stored!.credentialID); expect(listed).not.toContain("counter");
});

it("signs a passkey-only user in from a new browser and advances the signature counter", async () => {
  const { device, identity } = await signUp();
  const result = await signIn(device);
  expect(result.verified.status).toBe(200); expect(await result.verified.json()).toEqual({ ok: true });
  const next = await authenticated(request("/session", undefined, result.cookie), authEnv());
  expect(next.userId).toBe(identity.userId); expect(next.sessionId).not.toBe(identity.sessionId);
  expect((await env.DB.prepare("SELECT counter FROM user_passkeys").first())!.counter).toBe(1);
  expect((await signIn(await authenticator())).verified.status).toBe(401);
  await env.DB.prepare("UPDATE app_users SET status='suspended'").run();
  expect((await signIn(device)).verified.status).not.toBe(200); expect(await count("user_sessions")).toBe(0);
});

it("leaves no user when attestation verification fails, the challenge is replayed, or the passkey INSERT fails", async () => {
  expect((await register(await authenticator(), "?context=Kaio", {}, withOrigin("https://evil.example"))).verified.status).toBe(500);
  expect(await count("app_users")).toBe(0);
  await env.DB.exec("CREATE TRIGGER fail_passkey_insert BEFORE INSERT ON user_passkeys BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  expect((await register(await authenticator(), "?context=Kaio")).verified.status).toBe(500);
  expect(await count("app_users")).toBe(0);
  await env.DB.exec("DROP TRIGGER fail_passkey_insert");
  const device = await authenticator(), started = await registrationOptions("?context=Kaio");
  const response = await attest(device, await started.response.json(), ORIGIN);
  const verify = () => authRoute(request("/passkey/verify-registration", { response, createSession: true }, started.cookie), authEnv());
  expect((await verify()).status).toBe(200); expect((await verify()).status).toBe(400);
  expect(await count("app_users")).toBe(1);
});

it("binds the relying party to a trusted page Origin and refuses untrusted ones", async () => {
  const { response } = await registrationOptions("?context=Kaio", { origin: FRONTEND, env: split() });
  expect((await response.json() as { rp: { id: string } }).rp.id).toBe(new URL(FRONTEND).hostname);
  expect((await register(await authenticator(), "?context=Kaio", { origin: FRONTEND, env: split() })).verified.status).toBe(200);
  for (const origin of [FRONTEND, "https://evil.example", "null"]) {
    expect((await registrationOptions("?context=Kaio", { origin })).response.status).toBe(403);
    expect((await signIn(await authenticator(), { origin })).verified.status).toBe(403);
  }
  const absent = request("/passkey/generate-authenticate-options"); absent.headers.delete("Origin");
  expect((await (await authRoute(absent, split())).json() as { rpId: string }).rpId).toBe(new URL(ORIGIN).hostname);
  const post = request("/passkey/verify-authentication", { response: {} }); post.headers.delete("Origin");
  expect((await authRoute(post, split())).status).toBe(403);
  expect(await count("app_users")).toBe(1);
});

it("refuses a ceremony started on one trusted origin and finished on another", async () => {
  const started = await registrationOptions("?context=Kaio", { origin: FRONTEND, env: split() });
  const response = await attest(await authenticator(), await started.response.json(), ORIGIN);
  expect((await authRoute(request("/passkey/verify-registration", { response }, started.cookie), split())).status).toBe(500);
  expect(await count("app_users")).toBe(0);
});

it("validates the display name and parameters at the boundary", async () => {
  for (const query of ["", "?context=", "?context=%20%20", `?context=${"x".repeat(41)}`, "?context=a%00b", "?context=a%0Ab", "?context=Kaio&name=other", "?context=Kaio&context=Kaio"])
    expect((await registrationOptions(query)).response.status).toBe(400);
  expect((await registrationOptions(`?context=${"é".repeat(40)}`)).response.status).toBe(200);
  expect((await authRoute(request("/passkey/generate-authenticate-options?userId=x"), authEnv())).status).toBe(400);
  expect((await authRoute(request("/passkey/verify-authentication", { response: [] }), authEnv())).status).toBe(400);
  expect((await authRoute(request("/passkey/verify-authentication", { response: {}, extra: 1 }), authEnv())).status).toBe(400);
  for (const path of ["/passkey/list-user-passkeys", "/passkey/update-passkey", "/passkey/delete-passkey"])
    for (const data of [undefined, {}]) expect((await authRoute(request(path, data), authEnv())).status).toBe(404);
});

it("adds a passkey to a fresh OAuth session with CSRF, then signs in with either credential", async () => {
  mockProviders();
  const googleAaguid = Uint8Array.from("ea9b8d664d011d213ce4b6b48cb575d4".match(/../g)!, byte => parseInt(byte, 16));
  const user = await login(), device = await authenticator(googleAaguid);
  expect((await registrationOptions("?context=Other", { cookie: user.cookie })).response.status).toBe(400);
  expect((await register(device, "", { cookie: user.cookie })).verified.status).toBe(403);
  const options = await registrationOptions("", { cookie: user.cookie });
  expect((await options.response.json() as { user: { name: string } }).user.name).toBe("Fixture User");
  expect((await register(device, "", { cookie: user.cookie, csrfToken: user.identity.csrfToken })).verified.status).toBe(200);
  expect(await count("app_users")).toBe(1);
  const passkeys = await (await authRoute(request("/passkeys", undefined, user.cookie), authEnv())).json() as { passkeys: Array<Record<string, unknown>> };
  expect(passkeys.passkeys).toHaveLength(1); expect(passkeys.passkeys[0]).toEqual({ id: expect.any(String), name: "Google Password Manager", createdAt: expect.any(String) });
  expect((await authenticated(request("/session", undefined, (await signIn(device)).cookie), authEnv())).userId).toBe(user.identity.userId);
  await env.DB.prepare("UPDATE user_sessions SET createdAt=?").bind(new Date(Date.now() - 600_000).toISOString()).run();
  expect((await registrationOptions("", { cookie: user.cookie })).response.status).toBe(401);
});

it("never attaches a passkey to a user other than the ceremony's", async () => {
  mockProviders();
  const user = await login();
  const signup = await registrationOptions("?context=Kaio");
  const response = await attest(await authenticator(), await signup.response.json(), ORIGIN);
  const hijack = await authRoute(request("/passkey/verify-registration", { response }, `${signup.cookie}; ${user.cookie}`, user.identity.csrfToken), authEnv());
  expect(hijack.status).toBe(401);
  const adding = await registrationOptions("", { cookie: user.cookie });
  const orphan = await attest(await authenticator(), await adding.response.json(), ORIGIN);
  const anonymous = adding.cookie.split("; ").filter(pair => !pair.startsWith("__Host-bazaarghost_session=")).join("; ");
  expect((await authRoute(request("/passkey/verify-registration", { response: orphan }, anonymous), authEnv())).status).toBe(403);
  expect(await count("user_passkeys")).toBe(0); expect(await count("app_users")).toBe(1);
});

it("refuses removing the last sign-in credential and revokes other sessions on removal", async () => {
  const owner = await signUp(), other = await signUp("Other");
  const ids = async (userId: string) => (await env.DB.prepare("SELECT id FROM user_passkeys WHERE userId=?").bind(userId).all<{ id: string }>()).results.map(row => row.id);
  const remove = (passkeyId: string) => authRoute(request("/delete-passkey", { passkeyId }, owner.cookie, owner.identity.csrfToken), authEnv());
  expect((await remove((await ids(owner.identity.userId))[0])).status).toBe(409);
  expect((await remove((await ids(other.identity.userId))[0])).status).toBe(409);
  expect((await register(await authenticator(), "", { cookie: owner.cookie, csrfToken: owner.identity.csrfToken })).verified.status).toBe(200);
  const elsewhere = await signIn(owner.device);
  expect((await remove((await ids(owner.identity.userId))[0])).status).toBe(200);
  expect(await ids(owner.identity.userId)).toHaveLength(1);
  expect((await authRoute(request("/session", undefined, elsewhere.cookie), authEnv())).status).toBe(401);
  expect((await authRoute(request("/session", undefined, owner.cookie), authEnv())).status).toBe(200);
});

it("counts a passkey as a credential when unlinking the last OAuth account", async () => {
  mockProviders();
  const user = await login(), device = await authenticator();
  expect((await register(device, "", { cookie: user.cookie, csrfToken: user.identity.csrfToken })).verified.status).toBe(200);
  const account = await env.DB.prepare("SELECT id FROM user_accounts").first<{ id: string }>();
  expect((await authRoute(request("/unlink-account", { accountId: account!.id }, user.cookie, user.identity.csrfToken), authEnv())).status).toBe(200);
  expect(await count("user_accounts")).toBe(0);
  expect((await authenticated(request("/session", undefined, user.cookie), authEnv())).userId).toBe(user.identity.userId);
  expect((await signIn(device)).verified.status).toBe(200);
  const relink = await complete(await start("discord", user.cookie, true));
  expect(relink.headers.get("location")).toBe(ORIGIN + "/done");
});

it("rate limits unauthenticated registration options durably", async () => {
  const statuses = [];
  for (let i = 0; i < 11; i++) statuses.push((await registrationOptions("?context=Kaio")).response.status);
  expect(statuses.slice(0, 10).every(status => status === 200)).toBe(true); expect(statuses[10]).toBe(429);
  expect(await count("app_users")).toBe(0);
});
