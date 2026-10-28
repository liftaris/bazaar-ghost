import { env } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setProfile, setStreamer } from '../admin';
import { claim, dispatch, plan, vodDetails } from '../processing';
import { one, statement } from '../http';
import { saveVideo, upsertAccount } from '../platforms';

const profile = (id = 1) => ({ id, profile_name: `profile-${id}`, crop_region: [0, 0, 1, 1], igd_crop_region: null, custom_edge: null, opaque_edge: true });
let vodId: number, chunkId: string;
beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
  await setProfile(env, profile());
  await setProfile(env, profile(2));
  await setStreamer(env, { id: 1, login: 'reviewed', sfde_profile_id: 1 });
  const vod = await one(env, "INSERT INTO vods(streamer_id,source_id,duration_seconds,ready_for_processing,bazaar_chapters) VALUES(1,'123',100,1,'[0,100]') RETURNING id");
  vodId = vod!.id;
  chunkId = (await plan(env, vodId))[0].id;
});
afterEach(() => vi.unstubAllGlobals());

it.each(['queued', 'processing'])('blocks changes to each processing setting while %s, including disabled work', async status => {
  await statement(env, 'UPDATE chunks SET status=? WHERE id=?', status, chunkId).run();
  await setStreamer(env, { id: 1, processing_enabled: false });
  for (const change of [
    { crop_region: [0.1, 0, 0.9, 1] }, { igd_crop_region: [0, 0, 0.1, 0.1] },
    { custom_edge: 0.8 }, { opaque_edge: false },
  ]) {
    await expect(setProfile(env, { ...profile(), ...change, profile_name: 'must-rollback' })).rejects.toMatchObject({ status: 409 });
  }
  expect((await vodDetails(env, '123')).profile).toMatchObject(profile());
  await setProfile(env, { ...profile(2), custom_edge: 0.8 });
});

it('allows renames and numerically equivalent no-ops, then permits edits after workers finish', async () => {
  await statement(env, "UPDATE sfde_profiles SET crop_region='[0.0, 0.0, 1.0, 1.0]' WHERE id=1").run();
  await statement(env, "UPDATE chunks SET status='queued' WHERE id=?", chunkId).run();
  await setProfile(env, { ...profile(), profile_name: 'renamed' });
  await setStreamer(env, { id: 1, sfde_profile_id: 1, display_name: 'Renamed creator' });
  await expect(setStreamer(env, { id: 1, sfde_profile_id: 2, display_name: 'must-rollback' })).rejects.toMatchObject({ status: 409 });
  expect((await one(env, 'SELECT display_name FROM streamers WHERE id=1'))!.display_name).toBe('Renamed creator');
  await statement(env, "UPDATE chunks SET status='completed' WHERE id=?", chunkId).run();
  await setProfile(env, { ...profile(), custom_edge: 0.8 });
  await setStreamer(env, { id: 1, sfde_profile_id: 2 });
});

it('honors independent video and platform account profile precedence', async () => {
  await statement(env, 'UPDATE vods SET sfde_profile_id=2 WHERE id=?', vodId).run();
  await statement(env, "UPDATE chunks SET status='queued' WHERE id=?", chunkId).run();
  const account = await upsertAccount(env, { source: 'youtube', source_id: 'UC' + 'a'.repeat(22), display_name: 'Linked uploader', streamer_id: 1, sfde_profile_id: 2, processing_enabled: true });
  const video = await saveVideo(env, { account_id: account.id, video: { source: 'youtube', source_id: 'abcdefghijk', title: 'Bazaar', duration_seconds: 100, bazaar_chapters: [0, 100] } });
  await statement(env, "UPDATE chunks SET status='processing' WHERE vod_id=?", video.id).run();
  await setStreamer(env, { id: 1, sfde_profile_id: 2 });
  await setStreamer(env, { id: 1, sfde_profile_id: 1 });
  await setProfile(env, { ...profile(), custom_edge: 0.8 });
  await expect(setProfile(env, { ...profile(2), opaque_edge: false })).rejects.toMatchObject({ status: 409 });
  expect((await vodDetails(env, 'abcdefghijk', 'youtube')).profile.id).toBe(2);
});

// Inject an operator write after dispatch's profile read, before its atomic reservation.
function afterDispatchRead(action: () => Promise<unknown>): D1Database {
  return new Proxy(env.DB, {
    get(db, key) {
      if (key === 'prepare') return (sql: string) => {
        const prepared = db.prepare(sql);
        if (!sql.includes('SELECT * FROM sfde_profiles WHERE id=?')) return prepared;
        const wrap = (prepared: D1PreparedStatement): D1PreparedStatement => new Proxy(prepared, {
          get(stmt, method) {
            if (method === 'bind') return (...args: unknown[]) => wrap(stmt.bind(...args));
            if (method === 'first') return async () => { const result = await stmt.first(); await action(); return result; };
            const value = Reflect.get(stmt, method);
            return typeof value === 'function' ? value.bind(stmt) : value;
          },
        });
        return wrap(prepared);
      };
      const value = Reflect.get(db, key);
      return typeof value === 'function' ? value.bind(db) : value;
    },
  });
}

it('rejects a same-ID crop change between dispatch read and reservation even with an unchanged timestamp', async () => {
  const previous = (await vodDetails(env, '123')).profile.updated_at;
  const db = afterDispatchRead(async () => {
    await setProfile(env, { ...profile(), crop_region: [0.1, 0, 0.9, 1] });
    await statement(env, 'UPDATE sfde_profiles SET updated_at=? WHERE id=1', previous).run();
  });
  expect((await dispatch({ ...env, DB: db, ENVIRONMENT: 'validation', OUTBOUND_ENABLED: 'true', GITHUB_TOKEN: 'test-only' }, vodId, { origin: "manual", inputs: { mode: "legacy", quality: "480p", runtime_image: null } })).chunkIds).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
  expect((await vodDetails(env, '123')).profile.crop_region).toEqual([0.1, 0, 0.9, 1]);
  expect((await one(env, 'SELECT status FROM chunks WHERE id=?', chunkId))!.status).toBe('pending');
});

it('allows a metadata-only edit between dispatch read and reservation', async () => {
  const db = afterDispatchRead(() => setProfile(env, { ...profile(), profile_name: 'renamed' }));
  expect((await dispatch({ ...env, DB: db, ENVIRONMENT: 'validation', OUTBOUND_ENABLED: 'true', GITHUB_TOKEN: 'test-only' }, vodId, { origin: "manual", inputs: { mode: "legacy", quality: "480p", runtime_image: null } })).chunkIds).toEqual([chunkId]);
  expect(fetch).toHaveBeenCalledOnce();
  expect((await vodDetails(env, '123')).profile.profile_name).toBe('renamed');
});

it('rejects stale manual profile/template expectations without taking ownership or deleting results', async () => {
  const original = (await vodDetails(env, '123')).profile;
  await setProfile(env, { ...profile(), custom_edge: 0.8 });
  expect(await claim(env, chunkId, null, { profile: original, oldTemplates: false })).toEqual({ claimed: false, claim_token: null });
  const current = (await vodDetails(env, '123')).profile;
  expect(await claim(env, chunkId, null, { profile: current, oldTemplates: true })).toEqual({ claimed: false, claim_token: null });
  expect(await one(env, 'SELECT status,attempt_count,claim_token FROM chunks WHERE id=?', chunkId)).toEqual({ status: 'pending', attempt_count: 0, claim_token: null });
  expect((await claim(env, chunkId, null, { profile: current, oldTemplates: false })).claimed).toBe(true);
  await expect(setProfile(env, profile())).rejects.toMatchObject({ status: 409 });
});
