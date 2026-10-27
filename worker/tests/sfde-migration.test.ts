import { applyD1Migrations, env as bindings } from "cloudflare:test";
import { expect, it } from "vitest";
import { one, rows, statement } from "../http";
const env = { ...bindings, DB: bindings.MIGRATION_DB };

it("migrates populated pre-0022 D1 atomically without retargeting FKs, losing pointers, identities, social state or notification history", async () => {
  // A separate local-only test D1. Start from the real historical migrations,
  // not a hand-written schema that might omit an incoming FK or dependent trigger.
  const migrations = env.TEST_MIGRATIONS;
  await applyD1Migrations(env.DB, migrations.filter(m => m.name < "0022"));
  try {
    await env.DB.batch([
      statement(env, "INSERT INTO sfde_profiles(id,profile_name,crop_region) VALUES(1,'migration','[0,0,1,1]')"),
      statement(env, "INSERT INTO streamers(id,login,display_name) VALUES(1,'migration','Migration')"),
      statement(env, "INSERT INTO vods(id,streamer_id,source_id,duration_seconds,recorded_at) VALUES(1,1,'123',120,'2026-09-01T00:00:00.000Z')"),
      statement(env, "INSERT INTO chunks(id,vod_id,start_seconds,end_seconds,chunk_index) VALUES('chunk',1,0,120,0)"),
      statement(env, "INSERT INTO search_names(name,gram_count) VALUES('legacy',1)"),
      ...[10,20,30,40].map(at => statement(env, `INSERT INTO detections(id,chunk_id,vod_id,username,username_lower,confidence,rank,frame_time_seconds,storage_path,igd,no_right_edge,truncated,created_at)
        VALUES(?,'chunk',1,'Legacy','legacy',0.95,'gold',?,? ,9,1,1,'2026-09-01T00:00:00.000Z')`, `legacy-${at}`, at, `/detections/old_${at}.jpg`)),
    ]);
    const anchors = await rows<{ id: number; anchor_seconds: number }>(env, "SELECT id,anchor_seconds FROM matchup_anchors ORDER BY id");
    const [a,b,c,d] = anchors.map(a => a.id);
    await env.DB.batch([
      statement(env, "UPDATE matchup_anchors SET matchup_id=? WHERE id=?", a,b),
      statement(env, "UPDATE matchups SET merged_into=?,origin='manual' WHERE id=?", a,b),
      statement(env, "UPDATE matchups SET status='hidden' WHERE id=?", a),
      statement(env, "UPDATE matchup_anchors SET current_detection_id=NULL WHERE id=?", c),
      statement(env, "INSERT INTO matchup_overrides(id,action,anchor_a,anchor_b,evidence,actor) VALUES('manual','link',?,?,'Reviewed populated historical encounter','operator')", a,b),
      statement(env, "INSERT INTO app_users(id,name,email,emailVerified,createdAt,updatedAt) VALUES('user','User','user@example.test',1,'2026-09-01','2026-09-01')"),
      statement(env, "INSERT INTO matchup_likes(matchup_id,origin_id,user_id) VALUES(?,?,'user')", a,b),
      statement(env, "INSERT INTO matchup_favorites(matchup_id,origin_id,user_id) VALUES(?,?,'user')", a,b),
      statement(env, "INSERT INTO matchup_comments(id,matchup_id,origin_id,author_id,body,original_body_hash) VALUES('comment',?,?,'user','Historical comment','hash')", a,b),
      statement(env, "INSERT INTO social_reports(id,reporter_id,matchup_id,origin_id,reason) VALUES('report','user',?,?,'Historical report')", a,b),
      statement(env, "INSERT INTO social_moderation_audit(request_id,target_type,target_id,action,reason) VALUES('audit','matchup',?,'hide','Historical moderation')", String(a)),
      statement(env, "INSERT INTO notification_subscriptions(id,discord_user_id,username,username_lower) VALUES(1,'user','Legacy','legacy')"),
      statement(env, "UPDATE notification_outbox_v2 SET sent_at='2026-09-01',suppressed_reason=NULL WHERE matchup_id=?", a),
      statement(env, "INSERT INTO notification_deliveries_v2(matchup_id,subscription_id,destination,status,attempts,last_error) VALUES(?,1,'dm:user','uncertain',1,'Historical interrupted delivery')", a),
      // Preserve every AUTOINCREMENT high-water mark, including deleted high IDs.
      statement(env, "UPDATE sqlite_sequence SET seq=seq+1000"),
    ]);
    expect(d).toBeGreaterThan(c);
    const preserved = ["matchup_anchors", "matchups", "matchup_likes", "matchup_favorites", "matchup_comments", "social_reports", "social_moderation_audit",
      "matchup_overrides", "notification_outbox_v2", "notification_deliveries_v2", "sessions", "recording_alignments", "sqlite_sequence", "vods", "chunks"];
    const snapshots = new Map<string, unknown>();
    const snapshot = (table: string) => rows(env, `SELECT * FROM ${table}${table === "sqlite_sequence" ? " WHERE name!='d1_migrations'" : ""}`);
    for (const table of preserved) snapshots.set(table, await snapshot(table));
    const before = await rows(env, "SELECT * FROM detections ORDER BY id");
    const incoming: Array<{ name: string }> = [];
    for (const { name } of await rows<{ name: string }>(env, "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")) {
      const fks = await rows(env, `PRAGMA foreign_key_list("${name.replaceAll('"','""')}")`);
      for (const fk of fks) if (fk.table === "detections") incoming.push({ name });
    }
    expect(incoming).toHaveLength(1);
    expect(incoming[0].name).toBe("matchup_anchors");

    await applyD1Migrations(env.DB, migrations.filter(m => m.name < "0024"));

    for (const table of preserved) expect(await snapshot(table), table).toEqual(snapshots.get(table));
    const after = await rows(env, "SELECT * FROM detections ORDER BY id");
    expect(after).toHaveLength(before.length);
    for (let i = 0; i < before.length; i++) {
      for (const [key, value] of Object.entries(before[i])) expect(after[i][key], `${before[i].id}.${key}`).toEqual(value);
      expect(after[i]).toMatchObject({ name_state: "legacy", encounter_confidence: null, field_evidence: "{}", ghost_hero: null, streamer_hero: null, wins_remaining: null, lethal: null });
    }
    expect(await rows(env, "PRAGMA foreign_key_check")).toEqual([]);
    expect(await rows(env, "SELECT name FROM sqlite_schema WHERE type='table' AND name IN('sfde_anchor_pointers','detections_next')")).toEqual([]);
    expect(await one(env, "SELECT current_detection_id FROM matchup_anchors WHERE id=?", a)).toEqual({ current_detection_id: "legacy-10" });
    expect(await one(env, "SELECT current_detection_id FROM matchup_anchors WHERE id=?", c)).toEqual({ current_detection_id: null });
    expect((await rows(env, "PRAGMA foreign_key_list(matchup_anchors)")).some(f => f.table === "detections")).toBe(true);
    expect((await rows(env, "PRAGMA foreign_key_list(matchup_anchors)")).some(f => f.table === "detections_next")).toBe(false);
    expect((await one(env, "SELECT count(*) AS n FROM notification_outbox_v2"))!.n).toBe((snapshots.get("notification_outbox_v2") as unknown[]).length);

    // The second, actual populated upgrade starts on schema23, including newer
    // publications whose proof/claim bodies must NOT revert to legacy defaults.
    await env.DB.batch([
      statement(env, "INSERT INTO vods(id,streamer_id,source_id,duration_seconds) VALUES(2,1,'456',120)"),
      statement(env, "INSERT INTO chunks(id,vod_id,start_seconds,end_seconds,chunk_index) VALUES('new-chunk',2,0,120,0)"),
      statement(env, "INSERT INTO search_names(name,gram_count) VALUES('whole name!',1)"),
      ...["complete", "masked", "partial", "obstructed", "unreadable"].map((state, i) => statement(env, `INSERT INTO detections(
        id,chunk_id,vod_id,username,username_lower,confidence,frame_time_seconds,name_state,encounter_confidence,
        ghost_hero,streamer_hero,wins_remaining,lethal,field_evidence,publish_id,publish_claim,publish_body,created_at)
        VALUES(?,'new-chunk',2,?,?,NULL,?,?,0.99,'vanessa','dooley',0,1,?,?,?,?, '2026-09-02T00:00:00.000Z')`,
        `modern-${state}`, state === "complete" ? "Whole name!" : null, state === "complete" ? "whole name!" : null,
        10 + i * 10, state, JSON.stringify({ username: { raw_text: `proof-${state}` } }), `publisher-${state}`, "claim-preserved", `exact body ${state}`)),
      statement(env, `INSERT INTO sfde_inference(request_id,chunk_id,body_sha256,task,model,prompt_version,utc_day,status,
        reserved_nano_usd,charged_nano_usd,response_json,created_at,updated_at)
        VALUES('ledger','new-chunk','hash','ghost_hero','model','v1','2026-09-02','completed',123,123,'{}','t','t')`),
    ]);
    await statement(env, "UPDATE matchup_anchors SET current_detection_id=NULL WHERE current_detection_id='modern-partial'").run();
    await statement(env, "UPDATE sqlite_sequence SET seq=seq+1000").run();
    const tables = ["detections", ...preserved, "sfde_inference", "search_names", "search_grams", "session_link_proposals", "proposal_evidence", "session_events"];
    const schema23 = new Map<string, Record<string, any>[]>();
    for (const table of tables) schema23.set(table, await snapshot(table));
    const beforeSchema = await rows(env, "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name");
    const policyMigration = migrations.find(m => m.name.startsWith("0024"))!;
    await expect(env.DB.batch([
      ...policyMigration.queries.map(sql => env.DB.prepare(sql)),
      statement(env, "INSERT INTO mutation_checks(id,ok) VALUES('forced-migration-rollback',0)"),
    ])).rejects.toThrow(/valid_mutation/);
    expect(await rows(env, "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name")).toEqual(beforeSchema);
    for (const table of tables) expect(await snapshot(table), `rollback ${table}`).toEqual(schema23.get(table));
    await applyD1Migrations(env.DB, migrations);
    for (const table of tables) {
      const actual = await snapshot(table);
      const expected = schema23.get(table)!;
      if (table === "vods" || table === "sessions") {
        expect(actual.map(({ streamer_mode: _mode, ...row }) => row), table).toEqual(expected);
      } else if (table === "detections") {
        expect(actual, table).toEqual(expected.map(row => ({ ...row, game_mode: null, tournament_wins: null, tournament_losses: null })));
      } else expect(actual, table).toEqual(expected);
    }
    expect(await rows(env, "SELECT id,streamer_mode FROM vods ORDER BY id")).toEqual([{ id: 1, streamer_mode: 0 }, { id: 2, streamer_mode: 1 }]);
    expect((await one(env, "SELECT s.streamer_mode FROM sessions s JOIN vods v ON v.session_id=s.id WHERE v.id=2"))!.streamer_mode).toBe(1);
    expect((await one(env, "SELECT username,confidence FROM public_sources WHERE detection_id='modern-complete'")))
      .toEqual({ username: "Whole name!", confidence: null });
    expect(await rows(env, "PRAGMA foreign_key_check")).toEqual([]);
    expect(await rows(env, "SELECT name FROM sqlite_schema WHERE type='table' AND name IN('name_policy_anchor_pointers','detections_next')")).toEqual([]);
    expect((await rows(env, "PRAGMA foreign_key_list(matchup_anchors)")).filter(f => f.from === "current_detection_id").map(f => f.table)).toEqual(["detections"]);
    for (const { name } of await rows<{ name: string }>(env, "SELECT name FROM sqlite_schema WHERE type='view'"))
      await rows(env, `SELECT * FROM "${name.replaceAll('"', '""')}" LIMIT 0`);
    expect((await rows(env, "PRAGMA index_list(detections)")).map(r => r.name)).toEqual(expect.arrayContaining([
      "detections_name", "detections_vod", "detections_chunk", "detections_storage_path", "detections_publish_id",
    ]));
    // The new SQL constraints, not just HTTP validation, permit retained fragments
    // but still forbid inventing text for unreadable/masked observations.
    await env.DB.batch([
      statement(env, "INSERT INTO search_names(name,gram_count) VALUES('observed fragment',1)"),
      statement(env, "UPDATE detections SET username='Observed fragment',username_lower='observed fragment',confidence=0.99 WHERE id='modern-obstructed'"),
    ]);
    await expect(statement(env, "UPDATE detections SET username='Observed fragment',username_lower='observed fragment',confidence=0.99 WHERE id='modern-masked'").run()).rejects.toThrow(/CHECK/);
    await expect(statement(env, "UPDATE detections SET username=NULL,username_lower=NULL,confidence=0.99 WHERE id='modern-partial'").run()).rejects.toThrow(/CHECK/);
  } finally {
    // Leave the shared setup contract intact even if a regression assertion fails.
    await applyD1Migrations(env.DB, migrations);
  }
});
