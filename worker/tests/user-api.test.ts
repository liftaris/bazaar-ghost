import { env } from 'cloudflare:workers';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../index';
import { scheduled } from '../jobs';
import { authEnv, cookies, login, mockProviders, ORIGIN, request } from './auth-fixture';

afterEach(() => vi.unstubAllGlobals());

it('routes disabled auth and public search without requesting machine credentials', async () => {
  const disabled = { ...authEnv(), AUTH_ENABLED: 'false' };
  const providers = await worker.fetch(request('/providers'), disabled);
  expect(providers.status).toBe(200);
  expect(await providers.json()).toEqual({ enabled: false, providers: [] });
  expect(providers.headers.get('Cache-Control')).toBe('no-store');
  const me = await worker.fetch(new Request(ORIGIN + '/api/v1/me'), disabled);
  expect(me.status).toBe(503);
  expect(me.headers.get('Cache-Control')).toBe('no-store');
  const search = await worker.fetch(new Request(ORIGIN + '/api/v1/search'), disabled);
  expect(search.status).toBe(200);
  expect(await search.json()).toEqual({ items: [], nextCursor: null });
});

it('only permits credentialed browser requests from an exact trusted origin', async () => {
  for (const origin of [ORIGIN, 'https://evil.example', 'https://auth-validation.example.org.evil.example', 'null']) {
    const response = await worker.fetch(new Request(ORIGIN + '/api/v1/matchups/1/like', {
      method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'x-csrf-token' },
    }), authEnv());
    expect(response.status).toBe(204);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Vary')).toContain('Origin');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin === ORIGIN ? origin : null);
    expect(response.headers.get('Access-Control-Allow-Credentials')).toBe(origin === ORIGIN ? 'true' : null);
    if (origin === ORIGIN) {
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('DELETE');
      expect(response.headers.get('Access-Control-Allow-Headers')).toContain('x-csrf-token');
    }
  }
});

it('preserves OAuth cookies through the Worker and exposes only safe authenticated identity', async () => {
  mockProviders();
  const start = await worker.fetch(request('/sign-in/social', { provider: 'discord', callbackURL: ORIGIN + '/done' }), authEnv());
  expect(start.status).toBe(200);
  const authorization = new URL((await start.json() as { url: string }).url);
  const callback = await worker.fetch(request('/callback/discord?code=fixture-code&state=' +
    encodeURIComponent(authorization.searchParams.get('state')!), undefined, cookies(start)), authEnv());
  expect(callback.headers.get('Location')).toBe(ORIGIN + '/done');
  expect(callback.headers.getSetCookie().map(value => value.split('=')[0])).toContain('__Host-bazaarghost_session');
  const response = await worker.fetch(new Request(ORIGIN + '/api/v1/me', {
    headers: { Cookie: cookies(callback), Origin: ORIGIN },
  }), authEnv());
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  const value = await response.json() as Record<string, unknown>;
  expect(value.name).toBe('Fixture User');
  expect(value.csrfToken).toMatch(/^[a-f0-9]{64}$/);
  expect(value).not.toHaveProperty('token');
  expect(value).not.toHaveProperty('email');
});

it('requires a user session for social writes and the admin credential for moderation', async () => {
  mockProviders();
  const { cookie, identity } = await login();
  const machine = await worker.fetch(new Request(ORIGIN + '/api/v1/matchups/1/like', {
    method: 'PUT', headers: { Authorization: `Bearer ${env.ADMIN_KEY}`, Origin: ORIGIN },
  }), authEnv());
  expect(machine.status).toBe(401);
  const user = await worker.fetch(new Request(ORIGIN + '/api/admin/social/users/' + identity.userId, {
    method: 'PUT', headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json',
      'X-CSRF-Token': identity.csrfToken }, body: JSON.stringify({ status: 'suspended', reason: 'test', request_id: crypto.randomUUID() }),
  }), authEnv());
  expect(user.status).toBe(401);
});

it('runs bounded internal auth expiry cleanup while outbound integrations are disabled', async () => {
  await env.DB.prepare("INSERT INTO auth_flows(stateHash,provider,expiresAt) VALUES('expired','discord',0),('live','twitch',?)").bind(Date.now() + 60_000).run();
  await scheduled({ cron: '* * * * *' } as ScheduledController, { ...authEnv(), OUTBOUND_ENABLED: 'false', AUTH_ENABLED: 'false' });
  expect(await env.DB.prepare('SELECT stateHash FROM auth_flows ORDER BY stateHash').all()).toMatchObject({ results: [{ stateHash: 'live' }] });
});
