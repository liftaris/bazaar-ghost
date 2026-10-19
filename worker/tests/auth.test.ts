import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authRoute, authenticated, cleanupAuth, identityCheck, requireCsrf } from "../auth";
import { atomic } from "../atomic";
import { statement } from "../http";
import { authEnv, complete, cookies, login, mockProviders, ORIGIN, request, start } from "./auth-fixture";

let subjects: ReturnType<typeof mockProviders>;
const count = async (table: string) => Number((await env.DB.prepare(`SELECT count(*) n FROM ${table}`).first())!.n);
beforeEach(async () => {
  await env.DB.batch(["auth_flows", "auth_rate_limits", "auth_verifications", "user_sessions", "user_accounts", "app_users"].map(t => env.DB.prepare(`DELETE FROM ${t}`)));
  subjects = mockProviders();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await env.DB.batch(["fail_account_insert", "fail_session_insert"].map(name => env.DB.prepare(`DROP TRIGGER IF EXISTS ${name}`)));
});

it("completes Discord login with native D1, identity-only scope, secure cookies and safe session output", async () => {
  const flow = await start();
  expect(flow.url.searchParams.get("scope")).toBe("identify");
  expect(flow.url.searchParams.get("prompt")).toBe("consent");
  const response = await complete(flow);
  expect(response.headers.get("location")).toBe(ORIGIN + "/done");
  const headers = response.headers.getSetCookie().join(" ");
  expect(headers).toContain("__Host-bazaarghost_session=");
  expect(headers).toContain("HttpOnly"); expect(headers).toContain("Secure"); expect(headers).toContain("SameSite=Lax"); expect(headers).not.toContain("Domain=");
  const session = await authRoute(request("/session", undefined, cookies(response)), authEnv());
  expect(session.status).toBe(200); expect(session.headers.get("cache-control")).toBe("no-store");
  const text = await session.text(); expect(text).toContain("Fixture User"); expect(text).not.toContain('"token"'); expect(text).not.toContain("email");
  expect(await env.DB.prepare("SELECT accessToken,refreshToken,idToken,password FROM user_accounts").first()).toEqual({ accessToken: null, refreshToken: null, idToken: null, password: null });
  expect((await env.DB.prepare("SELECT registeredAt FROM app_users").first())!.registeredAt).toBeGreaterThan(0);
});
it("validates Twitch application and Helix subject without trusting an ID token or requesting email", async () => {
  const flow = await start("twitch"); expect(flow.url.searchParams.get("scope") || "").toBe("");
  const response = await complete(flow, "twitch"); expect(response.headers.get("location")).toBe(ORIGIN + "/done");
  expect(await env.DB.prepare("SELECT providerId,accountId,accessToken FROM user_accounts").first()).toEqual({ providerId: "twitch", accountId: subjects.twitch, accessToken: null });
});
it("rejects different-browser callbacks without consuming the valid browser's flow", async () => {
  const flow = await start(); const wrong = await complete(flow, "discord", "");
  expect(wrong.status).toBe(403); expect(await count("app_users")).toBe(0);
  expect((await complete(flow)).headers.get("location")).toBe(ORIGIN + "/done");
});
it("atomically consumes OAuth state under concurrent callback delivery", async () => {
  const flow = await start(); const responses = await Promise.all([complete(flow), complete(flow)]);
  expect(responses.filter(r => r.headers.get("location") === ORIGIN + "/done")).toHaveLength(1);
  expect(responses.filter(r => r.status === 403)).toHaveLength(1);
  expect(await count("user_sessions")).toBe(1);
  expect((await complete(flow)).status).toBe(403);
});
it("binds state to its provider and refuses expired state", async () => {
  const flow = await start(); expect((await complete(flow, "twitch")).status).toBe(403);
  expect((await complete(flow)).headers.get("location")).toBe(ORIGIN + "/done");
  const expired = await start(); await env.DB.prepare("UPDATE auth_flows SET expiresAt=0 WHERE consumedAt IS NULL").run();
  expect((await complete(expired)).status).toBe(403);
});
it("denies all stock token, profile-write, credentials and session-response endpoints", async () => {
  const { cookie } = await login();
  for (const path of ["/get-session", "/list-sessions", "/list-accounts", "/get-access-token", "/refresh-token", "/account-info", "/update-user", "/delete-user", "/change-email", "/sign-in/email", "/sign-up/email", "/sign-in/anonymous"])
    for (const data of [undefined, {}]) expect((await authRoute(request(path, data, cookie), authEnv())).status).toBe(404);
});
it("rejects client-controlled grant parameters, account status and unsafe redirect targets", async () => {
  for (const extra of [{ scopes: ["email"] }, { idToken: { token: "fake" } }, { additionalParams: {} }, { additionalData: { link: "fake" } }, { status: "active" }, { errorCallbackURL: "https://evil.example" }, { disableRedirect: false }])
    expect((await authRoute(request("/sign-in/social", { provider: "discord", ...extra }), authEnv())).status).toBe(400);
  await env.DB.prepare("DELETE FROM auth_rate_limits").run();
  for (const callbackURL of ["https://evil.example/", "//evil.example/", "javascript:alert(1)", "https://user:pass@auth-validation.example.org/"])
    expect((await authRoute(request("/sign-in/social", { provider: "discord", callbackURL }), authEnv())).status).toBe(403);
});
it("requires JSON and a trusted Origin before state creation", async () => {
  const evil = request("/sign-in/social", { provider: "discord" }, "", "", "https://evil.example");
  expect((await authRoute(evil, authEnv())).status).toBe(403);
  const absent = request("/sign-in/social", { provider: "discord" }); absent.headers.delete("Origin");
  expect((await authRoute(absent, authEnv())).status).toBe(403);
  const form = request("/sign-in/social", { provider: "discord" }); form.headers.set("Content-Type", "text/plain");
  expect((await authRoute(form, authEnv())).status).toBe(415);
  expect(await count("auth_flows")).toBe(0);
});
it("links explicitly, keeps one local user and returns the same owner on provider login", async () => {
  const first = await login(); const linked = await complete(await start("twitch", first.cookie, true), "twitch");
  expect(linked.headers.get("location")).toBe(ORIGIN + "/done"); expect(await count("app_users")).toBe(1); expect(await count("user_accounts")).toBe(2);
  const returning = await login("twitch"); expect(returning.identity.userId).toBe(first.identity.userId);
});
it("rejects linking without CSRF, from an old session, or after original-session revocation", async () => {
  const user = await login();
  expect((await authRoute(request("/link-social", { provider: "twitch" }, user.cookie), authEnv())).status).toBe(403);
  const flow = await start("twitch", user.cookie, true);
  await env.DB.prepare("DELETE FROM user_sessions WHERE id=?").bind(user.identity.sessionId).run();
  expect((await complete(flow, "twitch")).status).toBe(403); expect(await count("user_accounts")).toBe(1);
  const again = await login(); await env.DB.prepare("UPDATE user_sessions SET createdAt=?").bind(new Date(Date.now()-600_000).toISOString()).run();
  expect((await authRoute(request("/link-social", { provider: "twitch" }, again.cookie, again.identity.csrfToken), authEnv())).status).toBe(401);
});
it("refuses taking an identity already registered by another user", async () => {
  const discord = await login(); const twitch = await login("twitch");
  expect(discord.identity.userId).not.toBe(twitch.identity.userId);
  const linked = await complete(await start("twitch", discord.cookie, true), "twitch");
  expect(linked.headers.get("location")).not.toBe(ORIGIN + "/done"); expect(await count("user_accounts")).toBe(2);
});
it("recovers only the failed invocation's unfinished registration after account INSERT fails", async () => {
  const existing = await login("twitch");
  await env.DB.exec("CREATE TRIGGER fail_account_insert BEFORE INSERT ON user_accounts WHEN NEW.providerId='discord' BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  const failed = await complete(await start()); expect(failed.headers.get("location")).not.toBe(ORIGIN + "/done");
  expect(await count("app_users")).toBe(1);
  expect((await authenticated(request("/session", undefined, existing.cookie), authEnv())).userId).toBe(existing.identity.userId);
  await env.DB.exec("DROP TRIGGER fail_account_insert");
  expect((await complete(await start())).headers.get("location")).toBe(ORIGIN + "/done"); expect(await count("app_users")).toBe(2);
});
it("retains a successfully registered identity when session creation fails, allowing retry", async () => {
  await env.DB.exec("CREATE TRIGGER fail_session_insert BEFORE INSERT ON user_sessions BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  const failed = await complete(await start()); expect(failed.headers.get("location")).not.toBe(ORIGIN + "/done");
  expect(await count("app_users")).toBe(1); expect(await count("user_accounts")).toBe(1); expect(await count("user_sessions")).toBe(0);
  await env.DB.exec("DROP TRIGGER fail_session_insert");
  expect((await complete(await start())).headers.get("location")).toBe(ORIGIN + "/done"); expect(await count("app_users")).toBe(1);
});
it("does not delete a concurrent successful signup when another callback fails", async () => {
  await env.DB.exec("CREATE TRIGGER fail_account_insert BEFORE INSERT ON user_accounts WHEN NEW.providerId='discord' BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  const discord = await start(), twitch = await start("twitch");
  const responses = await Promise.all([complete(discord), complete(twitch, "twitch")]);
  expect(responses[1].headers.get("location")).toBe(ORIGIN + "/done"); expect(await count("app_users")).toBe(1);
  expect((await env.DB.prepare("SELECT providerId FROM user_accounts").first())!.providerId).toBe("twitch");
});
it("cleans up aged abandoned registrations, never previously registered or fresh users", async () => {
  const registered = await login();
  await env.DB.prepare("DELETE FROM user_sessions WHERE userId=?").bind(registered.identity.userId).run();
  await env.DB.prepare("DELETE FROM user_accounts WHERE userId=?").bind(registered.identity.userId).run();
  for (const [id, createdAt] of [["aged", Date.now()-7_200_000], ["fresh", Date.now()]] as const)
    await env.DB.prepare("INSERT INTO app_users(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,0,?,?)").bind(id,id,id+"@test.invalid",new Date(createdAt).toISOString(),new Date(createdAt).toISOString()).run();
  await env.DB.prepare("UPDATE app_users SET createdAt='1970-01-01T00:00:00.000Z' WHERE id=?").bind(registered.identity.userId).run();
  await cleanupAuth(authEnv());
  expect(await env.DB.prepare("SELECT id FROM app_users WHERE id='aged'").first()).toBeNull();
  expect(await count("app_users")).toBe(2);
});
it("rejects suspended users immediately and does not recreate sessions through returning login", async () => {
  const user = await login(); await env.DB.prepare("UPDATE app_users SET status='suspended' WHERE id=?").bind(user.identity.userId).run();
  expect(await count("user_sessions")).toBe(0);
  expect((await authRoute(request("/session", undefined, user.cookie), authEnv())).status).toBe(401);
  expect((await complete(await start())).headers.get("location")).not.toBe(ORIGIN + "/done"); expect(await count("user_sessions")).toBe(0);
});
it("requires same-session CSRF and fences an authorization check against later revocation", async () => {
  const first = await login(), second = await login();
  await expect(requireCsrf(request("/sign-out", {}, first.cookie, second.identity.csrfToken), authEnv(), first.identity)).rejects.toThrow("CSRF");
  await env.DB.prepare("DELETE FROM user_sessions WHERE id=?").bind(first.identity.sessionId).run();
  await expect(atomic(env, [identityCheck(first.identity)], [statement(env, "UPDATE app_users SET name='wrong' WHERE id=?", first.identity.userId)])).rejects.toThrow("State changed");
  expect((await env.DB.prepare("SELECT name FROM app_users").first())!.name).toBe("Fixture User");
});
it("atomically retains at least one account when two unlink requests race", async () => {
  const user = await login(); await complete(await start("twitch", user.cookie, true), "twitch");
  const accounts = (await env.DB.prepare("SELECT id FROM user_accounts").all<{id:string}>()).results;
  const responses = await Promise.all(accounts.map(account => authRoute(request("/unlink-account", { accountId: account.id }, user.cookie, user.identity.csrfToken), authEnv())));
  expect(responses.map(r => r.status).sort()).toEqual([200,409]); expect(await count("user_accounts")).toBe(1);
});
it("cannot unlink or revoke another user's account or session", async () => {
  const first = await login(); subjects.discord = "100000000000000002"; const second = await login();
  const account = await env.DB.prepare("SELECT id FROM user_accounts WHERE userId=?").bind(second.identity.userId).first<{id:string}>();
  expect((await authRoute(request("/unlink-account", { accountId: account!.id }, first.cookie, first.identity.csrfToken), authEnv())).status).toBe(409);
  expect((await authRoute(request("/revoke-session", { sessionId: second.identity.sessionId }, first.cookie, first.identity.csrfToken), authEnv())).status).toBe(200);
  expect((await authenticated(request("/session", undefined, second.cookie), authEnv())).userId).toBe(second.identity.userId);
});
it("signs out one session, then all sessions; session and account listings contain no grants", async () => {
  const first = await login(), second = await login();
  const rawToken = String((await env.DB.prepare("SELECT token FROM user_sessions WHERE id=?").bind(first.identity.sessionId).first())!.token);
  for (const path of ["/session", "/sessions", "/accounts"]) {
    const response = await authRoute(request(path, undefined, first.cookie), authEnv());
    const text = await response.text(); expect(text).not.toContain(rawToken); expect(text).not.toContain("fixture-discord-token"); expect(text).not.toContain("email");
  }
  expect((await authRoute(request("/sign-out", {}, first.cookie, first.identity.csrfToken), authEnv())).status).toBe(200);
  expect((await authRoute(request("/session", undefined, first.cookie), authEnv())).status).toBe(401);
  expect((await authRoute(request("/sign-out-all", {}, second.cookie, second.identity.csrfToken), authEnv())).status).toBe(200);
  expect(await count("user_sessions")).toBe(0);
});
it("deletes only the fresh authenticated user's local account and credentials", async () => {
  const first = await login(); subjects.discord = "100000000000000002"; const second = await login();
  expect((await authRoute(request("/delete-account", {}, first.cookie, first.identity.csrfToken), authEnv())).status).toBe(200);
  expect(await count("app_users")).toBe(1); expect(await count("user_accounts")).toBe(1); expect(await count("user_sessions")).toBe(1);
  expect((await authenticated(request("/session", undefined, second.cookie), authEnv())).userId).toBe(second.identity.userId);
});
it("limits login starts durably before allocating unlimited OAuth state", async () => {
  const statuses = [];
  for (let i=0; i<12; i++) statuses.push((await authRoute(request("/sign-in/social", {provider:"discord"}), authEnv())).status);
  expect(statuses.filter(s=>s===200)).toHaveLength(10); expect(statuses.slice(10)).toEqual([429,429]);
  expect(await count("auth_flows")).toBe(10);
});
it("stays disabled without configuration and performs no outbound calls when integrations are disabled", async () => {
  expect((await authRoute(request("/providers"), {...authEnv(),AUTH_ENABLED:"false"})).status).toBe(200);
  expect((await authRoute(request("/sign-in/social",{provider:"discord"}), {...authEnv(),AUTH_ENABLED:"false"})).status).toBe(503);
  expect((await authRoute(request("/sign-in/social",{provider:"discord"}), {...authEnv(),OUTBOUND_ENABLED:"false"})).status).toBe(503);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("expires sessions in both the library and atomic mutation fences, and cleans expired metadata", async () => {
  const user = await login(); const expired = new Date(Date.now()-60_000).toISOString();
  await env.DB.prepare("UPDATE user_sessions SET expiresAt=?").bind(expired).run();
  await expect(atomic(env, [identityCheck(user.identity)], [statement(env,"UPDATE app_users SET name='wrong' WHERE id=?",user.identity.userId)])).rejects.toThrow("State changed");
  expect((await authRoute(request("/session",undefined,user.cookie),authEnv())).status).toBe(401);
  await env.DB.prepare("UPDATE auth_verifications SET expiresAt=?").bind(expired).run();
  await env.DB.prepare("UPDATE auth_flows SET expiresAt=0").run();
  await env.DB.prepare("UPDATE auth_rate_limits SET expiresAt=0").run();
  await cleanupAuth(authEnv());
  for(const table of ["auth_verifications","auth_flows","auth_rate_limits","user_sessions"]) expect(await count(table)).toBe(0);
  expect(await count("app_users")).toBe(1);
});
it("fences fresh-session checks using the actual ISO date storage", async () => {
  const user=await login();
  const row=await env.DB.prepare("SELECT typeof(createdAt) type,createdAt FROM user_sessions").first<{type:string;createdAt:string}>();
  expect(row!.type).toBe("text"); expect(row!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  await env.DB.prepare("UPDATE user_sessions SET createdAt=?").bind(new Date(Date.now()-600_000).toISOString()).run();
  await expect(atomic(env,[identityCheck(user.identity,true)],[statement(env,"SELECT 1")])).rejects.toThrow("State changed");
  await expect(atomic(env,[identityCheck(user.identity)],[statement(env,"SELECT 1")])).resolves.toBeTruthy();
});
it("blocks linking when the original session is revoked while the provider profile is loading", async () => {
  const user=await login(), flow=await start("twitch",user.cookie,true);
  const original=globalThis.fetch;
  vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=input instanceof Request?input.url:String(input);
    if(url==="https://api.twitch.tv/helix/users") await env.DB.prepare("DELETE FROM user_sessions WHERE id=?").bind(user.identity.sessionId).run();
    return original(input,init);
  }));
  const result=await complete(flow,"twitch");
  expect(result.headers.get("location")).not.toBe(ORIGIN+"/done"); expect(await count("user_accounts")).toBe(1);
});
it("blocks a session when its user is suspended during provider identity retrieval", async () => {
  const user=await login(),flow=await start(); const original=globalThis.fetch;
  vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=input instanceof Request?input.url:String(input);
    if(decodeURIComponent(url)==="https://discord.com/api/users/@me")
      await env.DB.prepare("UPDATE app_users SET status='suspended' WHERE id=?").bind(user.identity.userId).run();
    return original(input,init);
  }));
  const result=await complete(flow); expect(result.headers.get("location")).not.toBe(ORIGIN+"/done"); expect(await count("user_sessions")).toBe(0);
});
it("does not implicitly merge users even when an email collision is injected",async()=>{
  const twitch=await login("twitch");
  await env.DB.prepare("UPDATE app_users SET email=? WHERE id=?").bind(`${subjects.discord}@discord.bazaarghost.invalid`,twitch.identity.userId).run();
  const result=await complete(await start()); expect(result.headers.get("location")).not.toBe(ORIGIN+"/done");
  expect(await count("app_users")).toBe(1);expect(await count("user_accounts")).toBe(1);
});
it("rejects mismatched Twitch application/subject and malformed or oversized provider identity",async()=>{
  const original=globalThis.fetch;
  for(const issue of ["client","subject","malformed","oversized"]){
    vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      const url=input instanceof Request?input.url:String(input);
      if(issue==="client"&&url==="https://id.twitch.tv/oauth2/validate")return Response.json({client_id:"another-app",user_id:subjects.twitch,expires_in:3600});
      if(issue==="subject"&&url==="https://api.twitch.tv/helix/users")return Response.json({data:[{id:"999999",display_name:"Wrong"}]});
      if(issue==="malformed"&&url==="https://id.twitch.tv/oauth2/validate")return Response.json({client_id:"twitch-client",user_id:"../../user",expires_in:3600});
      if(issue==="oversized"&&url==="https://api.twitch.tv/helix/users")return Response.json({data:[],padding:"x".repeat(70_000)});
      return original(input,init);
    }));
    const response=await complete(await start("twitch"),"twitch");expect(response.headers.get("location")).not.toBe(ORIGIN+"/done");
  }
  expect(await count("app_users")).toBe(0);
});
it("keeps provider errors and tokens out of error responses",async()=>{
  const flow=await start(),original=globalThis.fetch;
  vi.stubGlobal("fetch",vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=input instanceof Request?input.url:String(input);
    if(decodeURIComponent(url)==="https://discord.com/api/users/@me")throw new Error("fixture-private-grant-should-never-leak");
    return original(input,init);
  }));
  const response=await complete(flow);expect(response.status).toBe(500);expect(await response.text()).not.toContain("fixture-private-grant");
});
it("rejects direct storage of grants and reassignment of an existing account identity",async()=>{
  await login();
  await expect(env.DB.prepare("UPDATE user_accounts SET accessToken='private-token'").run()).rejects.toThrow("CHECK");
  await expect(env.DB.prepare("UPDATE user_accounts SET accountId='1234'").run()).rejects.toThrow("Invalid account update");
});
it("denies forged cookies and machine credentials as user identities",async()=>{
  const user=await login();
  // Always change the first character; a token that already starts with "x" would be unforged.
  const forged=request("/session",undefined,user.cookie.replace(/bazaarghost_session=(.)/,(_,first)=>`bazaarghost_session=${first==="x"?"y":"x"}`));
  expect((await authRoute(forged,authEnv())).status).toBe(401);
  const machine=request("/session");machine.headers.set("Authorization",`Bearer ${env.ADMIN_KEY}`);
  expect((await authRoute(machine,authEnv())).status).toBe(401);
});
it("serves a safe callback error destination without echoing provider descriptions",async()=>{
  const response=await authRoute(request("/error?error_description=fixture-private-value"),authEnv());
  expect(response.status).toBe(400);expect(await response.text()).not.toContain("fixture-private-value");
});
