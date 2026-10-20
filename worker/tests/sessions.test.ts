import { env, SELF } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import { createStreamer, linkChannel } from '../streamers';
import { saveVideo, upsertAccount } from '../platforms';
import { mergeSessions, moveRecording, recomputeSessionStreamer, revokeAlignment, segmentToRecording, segmentToSession, setAlignment, toRecording, toSession, undoSessionEvent } from '../sessions';
import { one, rows } from '../http';

const how = { actor: 'tester', evidence: 'matched overlay' };
const admin = (path: string, method = 'GET', data?: unknown) => SELF.fetch(`http://local${path}`, {
  method, headers: { Authorization: `Bearer ${env.ADMIN_KEY}`, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });

beforeEach(async () => {
  await env.DB.exec("INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'p','[0,0,1,1]')");
});
async function recording(source: string, sourceId: string, accountSource = 'youtube', extra: Record<string, unknown> = {}) {
  const channel = await upsertAccount(env, { source: accountSource, source_id: accountSource === 'youtube' ? 'UC' + 'a'.repeat(22) : '12345', display_name: 'Creator' });
  return saveVideo(env, { account_id: channel.id, video: { source, source_id: sourceId, title: 't', duration_seconds: 3600, published_at: '2026-09-07T10:00:00Z',
    template_version: 'auto', content_kind: 'upload', bazaar_chapters: [0, 3600], ...extra } });
}
async function anchor(vodId: number, seconds: number) {
  await env.DB.prepare('INSERT INTO matchup_anchors(vod_id,anchor_seconds) VALUES(?,?)').bind(vodId, seconds).run();
  return (await one(env, 'SELECT matchup_id FROM matchup_anchors WHERE vod_id=? AND anchor_seconds=?', vodId, seconds))!.matchup_id as number;
}
const session = async (vodId: number) => (await one(env, 'SELECT session_id FROM vods WHERE id=?', vodId))!.session_id as string;
const matchup = (id: number) => one(env, 'SELECT session_id,session_time FROM matchups WHERE id=?', id);

it('gives every inserted Recording a singleton Session with an offset-0 alignment, and Matchups take its time', async () => {
  const v = await recording('youtube', 'abcdefghijk');
  const sid = await session(v.id);
  expect(sid).toMatch(/^[0-9a-f]{32}$/);
  expect(await rows(env, 'SELECT origin,streamer_id FROM sessions')).toEqual([{ origin: 'singleton', streamer_id: (await one(env, 'SELECT id FROM streamer_identities WHERE provisional_channel_id IS NOT NULL'))!.id }]);
  expect(await rows(env, 'SELECT session_id,vod_id,rec_start,rec_end,offset_seconds,method FROM recording_alignments'))
    .toEqual([{ session_id: sid, vod_id: v.id, rec_start: 0, rec_end: null, offset_seconds: 0, method: 'singleton' }]);
  const m = await anchor(v.id, 120);
  expect(await matchup(m)).toEqual({ session_id: sid, session_time: 120 });
});

it('takes the singleton Streamer from the Channel owner, and Twitch from the Streamer', async () => {
  const owner = await createStreamer(env, { display_name: 'Owner' });
  const channel = await upsertAccount(env, { source: 'youtube', source_id: 'UC' + 'b'.repeat(22), display_name: 'Owned' });
  await linkChannel(env, owner.id, channel.id, { method: 'operator', actor: 'tester' });
  const v = await saveVideo(env, { account_id: channel.id, video: { source: 'youtube', source_id: "abcdefghijk", title: "t", duration_seconds: 60, bazaar_chapters: [0, 60], content_kind: 'upload', template_version: 'auto' } });
  expect((await one(env, 'SELECT streamer_id FROM sessions WHERE id=?', await session(v.id)))!.streamer_id).toBe(owner.id);
  await env.DB.exec("INSERT INTO streamers(id,login) VALUES(77,'tw'); INSERT INTO vods(streamer_id,source_id,duration_seconds,bazaar_chapters) VALUES(77,'t1',60,'[0,60]')");
  expect((await one(env, "SELECT s.streamer_id FROM sessions s JOIN vods v ON v.session_id=s.id WHERE v.source_id='t1'"))!.streamer_id).toBe(77);
});

it('converts offsets and segments in both directions with unmapped gaps', async () => {
  const segs = [{ rec_start: 0, rec_end: 100, offset_seconds: 50 }, { rec_start: 200, rec_end: null, offset_seconds: -100 }];
  expect(segmentToSession(segs, 10)).toBe(60);
  expect(segmentToSession(segs, 100)).toBeNull();
  expect(segmentToSession(segs, 250)).toBe(150);
  expect(segmentToRecording(segs, 60)).toBe(10);
  expect(segmentToRecording(segs, 150)).toBe(250);
  expect(segmentToRecording(segs, 20)).toBeNull();

  const v = await recording('youtube', 'abcdefghijk'), sid = await session(v.id);
  await setAlignment(env, sid, v.id, segs, how);
  expect(await toSession(env, v.id, 10)).toEqual({ session_id: sid, time: 60 });
  expect(await toSession(env, v.id, 150)).toBeNull();
  expect(await toRecording(env, sid, v.id, 150)).toBe(250);
  expect(await toRecording(env, sid, v.id, 20)).toBeNull();
});

it('maps two Bilibili parts of one BV into one Session at different offsets and keeps mappings when parts reorder', async () => {
  const bili = (cid: string, index: number) => recording('bilibili', `BV1234567890:${cid}`, 'bilibili', { source_video_id: 'BV1234567890', source_part_id: cid, source_part_index: index });
  const p1 = await bili('111', 1), p2 = await bili('222', 2);
  const sid = await session(p1.id);
  await moveRecording(env, p2.id, sid, 3600, how);
  expect(await session(p2.id)).toBe(sid);
  expect(await toSession(env, p2.id, 10)).toEqual({ session_id: sid, time: 3610 });
  await bili('111', 2); await bili('222', 1);
  expect((await rows(env, 'SELECT id,source_part_index FROM vods ORDER BY id'))).toEqual([{ id: p1.id, source_part_index: 2 }, { id: p2.id, source_part_index: 1 }]);
  expect(await toSession(env, p2.id, 10)).toEqual({ session_id: sid, time: 3610 });
  expect(await toSession(env, p1.id, 10)).toEqual({ session_id: sid, time: 10 });
});

it('gives a replaced Bilibili part (new CID) a new singleton Session', async () => {
  const old = await recording('bilibili', 'BV1234567890:111', 'bilibili', { source_video_id: 'BV1234567890', source_part_id: '111', source_part_index: 1 });
  const fresh = await recording('bilibili', 'BV1234567890:999', 'bilibili', { source_video_id: 'BV1234567890', source_part_id: '999', source_part_index: 1 });
  expect(await session(fresh.id)).not.toBe(await session(old.id));
});

it('keeps the Session, alignments and Matchups when a Recording expires or is deleted (SES-04)', async () => {
  const v = await recording('youtube', 'abcdefghijk'), sid = await session(v.id), m = await anchor(v.id, 30);
  await env.DB.prepare("UPDATE vods SET availability='expired' WHERE id=?").bind(v.id).run();
  expect(await matchup(m)).toEqual({ session_id: sid, session_time: 30 });
  await env.DB.prepare('DELETE FROM vods WHERE id=?').bind(v.id).run();
  expect(await one(env, 'SELECT id FROM sessions WHERE id=?', sid)).toEqual({ id: sid });
  expect(await rows(env, 'SELECT vod_id FROM recording_alignments WHERE revoked_at IS NULL')).toEqual([{ vod_id: v.id }]);
  expect(await matchup(m)).toEqual({ session_id: sid, session_time: 30 });
});

it('rejects overlapping segments, in code and by trigger, and a split of one Recording across Sessions', async () => {
  const a = await recording('youtube', 'abcdefghijk'), b = await recording('youtube', 'bbcdefghijk'), sid = await session(a.id);
  await expect(setAlignment(env, sid, a.id, [{ rec_start: 0, rec_end: 100, offset_seconds: 0 }, { rec_start: 50, rec_end: null, offset_seconds: 5 }], how)).rejects.toMatchObject({ status: 400 });
  await setAlignment(env, sid, a.id, [{ rec_start: 0, rec_end: 100, offset_seconds: 0 }], how);
  const insert = (session_id: string, vod: number, start: number, end: number | null) => env.DB.prepare(
    "INSERT INTO recording_alignments(session_id,vod_id,rec_start,rec_end,offset_seconds,method,actor) VALUES(?,?,?,?,0,'operator','t')").bind(session_id, vod, start, end).run();
  await expect(insert(sid, a.id, 99, 200)).rejects.toThrow(/overlap/);
  await insert(sid, a.id, 100, 200);
  await expect(insert(await session(b.id), a.id, 300, null)).rejects.toThrow(/one session/);
  await expect(revokeAlignment(env, (await one(env, 'SELECT id FROM recording_alignments WHERE vod_id=? AND rec_start=0 AND revoked_at IS NULL', a.id))!.id, how)).resolves.toBeTruthy();
  await expect(revokeAlignment(env, (await one(env, 'SELECT id FROM recording_alignments WHERE vod_id=? AND revoked_at IS NULL', a.id))!.id, how)).rejects.toMatchObject({ status: 409 });
});

it('merges Sessions and undo restores the original offsets, Matchups and Streamers', async () => {
  const a = await recording('youtube', 'abcdefghijk'), b = await recording('youtube', 'bbcdefghijk');
  const [sa, sb] = [await session(a.id), await session(b.id)];
  const ma = await anchor(a.id, 100), mb = await anchor(b.id, 40);
  const merged = await mergeSessions(env, sa, sb, 900, how);
  expect(merged.session.alignments.map((r: any) => [r.vod_id, r.offset_seconds]).sort()).toEqual([[a.id, 0], [b.id, 900]]);
  expect(await one(env, 'SELECT merged_into FROM sessions WHERE id=?', sb)).toEqual({ merged_into: sa });
  expect(await session(b.id)).toBe(sa);
  expect(await matchup(mb)).toEqual({ session_id: sa, session_time: 940 });
  await expect(mergeSessions(env, sa, sb, 0, how)).rejects.toMatchObject({ status: 409 });

  await undoSessionEvent(env, merged.event_id, how);
  expect(await session(b.id)).toBe(sb);
  expect(await one(env, 'SELECT merged_into FROM sessions WHERE id=?', sb)).toEqual({ merged_into: null });
  expect(await rows(env, 'SELECT vod_id,session_id,offset_seconds FROM recording_alignments WHERE revoked_at IS NULL ORDER BY vod_id'))
    .toEqual([{ vod_id: a.id, session_id: sa, offset_seconds: 0 }, { vod_id: b.id, session_id: sb, offset_seconds: 0 }]);
  expect(await matchup(mb)).toEqual({ session_id: sb, session_time: 40 });
  expect(await matchup(ma)).toEqual({ session_id: sa, session_time: 100 });
  await expect(undoSessionEvent(env, merged.event_id, how)).rejects.toMatchObject({ status: 409 });
});

it('refuses to merge Sessions of two Streamers unless the operator chooses one', async () => {
  const x = await createStreamer(env, { display_name: 'X' }), y = await createStreamer(env, { display_name: 'Y' });
  const own = async (streamer: number, letter: string, id: string) => {
    const channel = await upsertAccount(env, { source: 'youtube', source_id: 'UC' + letter.repeat(22), display_name: letter });
    await linkChannel(env, streamer, channel.id, { method: 'operator', actor: 't' });
    return saveVideo(env, { account_id: channel.id, video: { source: 'youtube', source_id: id, title: "t", duration_seconds: 60, bazaar_chapters: [0, 60], content_kind: 'upload', template_version: 'auto' } });
  };
  const a = await own(x.id, 'c', 'abcdefghijk'), b = await own(y.id, 'd', 'bbcdefghijk');
  const [sa, sb] = [await session(a.id), await session(b.id)];
  await expect(mergeSessions(env, sa, sb, 5, how)).rejects.toMatchObject({ status: 409 });
  await expect(mergeSessions(env, sa, sb, 5, how, 999)).rejects.toMatchObject({ status: 400 });
  expect(await one(env, 'SELECT merged_into FROM sessions WHERE id=?', sb)).toEqual({ merged_into: null });
  const done = await mergeSessions(env, sa, sb, 5, how, y.id);
  expect((done.session as any).streamer_id).toBe(y.id);
  expect((await recomputeSessionStreamer(env, sa)).conflict).toBe(true);
  expect((await one(env, 'SELECT streamer_id FROM sessions WHERE id=?', sa))!.streamer_id).toBe(y.id);
  await undoSessionEvent(env, done.event_id, how);
  expect((await one(env, 'SELECT streamer_id FROM sessions WHERE id=?', sa))!.streamer_id).toBe(x.id);
});

it('bumps public revisions for operator changes but not for singleton creation', async () => {
  const revisions = async () => (await one(env, 'SELECT (SELECT revision FROM public_cache_state) c,(SELECT revision FROM public_search_state) s'))!;
  const a = await recording('youtube', 'abcdefghijk');
  const start = await revisions();
  const b = await recording('youtube', 'bbcdefghijk');
  expect(await revisions()).toEqual(start);
  await moveRecording(env, b.id, await session(a.id), 10, how);
  const after = await revisions();
  expect(after.c).toBeGreaterThan(start.c as number);
  expect(after.s).toBeGreaterThan(start.s as number);
});

it('serves operator Session routes behind the admin key', async () => {
  const a = await recording('youtube', 'abcdefghijk'), b = await recording('youtube', 'bbcdefghijk');
  const [sa, sb] = [await session(a.id), await session(b.id)];
  expect((await SELF.fetch('http://local/api/admin/sessions')).status).toBe(401);
  const list = await (await admin('/api/admin/sessions')).json() as any[];
  expect(list.map(s => s.id).sort()).toEqual([sa, sb].sort());
  const move = await admin(`/api/admin/sessions/${sa}/alignments`, 'POST', { vod_id: b.id, segments: [{ rec_start: 0, rec_end: null, offset_seconds: 12 }], actor: 'op' });
  expect(move.status).toBe(200);
  const detail = await (await admin(`/api/admin/sessions/${sa}`)).json() as any;
  expect(detail.alignments.map((r: any) => r.offset_seconds).sort()).toEqual([0, 12]);
  const event = (await move.json() as any).event_id;
  expect((await admin(`/api/admin/sessions/${sa}/undo`, 'POST', { event_id: event })).status).toBe(200);
  expect((await admin(`/api/admin/sessions/${sa}/merge`, 'POST', { from: sb, delta: 'x' })).status).toBe(400);
  expect((await admin(`/api/admin/sessions/${sa}/merge`, 'POST', { from: sb, delta: 30 })).status).toBe(200);
  expect((await admin('/api/admin/sessions/nope')).status).toBe(404);
});
