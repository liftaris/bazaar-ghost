import {
  authorized,
  body,
  HttpError,
  integer,
  now,
  readText,
  one,
  requireValue,
  rows,
  statement,
  uuid,
} from "./http";
import { claim, dispatch, plan, updateChunk, vodDetails } from "./processing";
import { clearChunk, publish, upload } from "./detections";
import { publicCache } from "./cache";
import { publicRead, rpc } from "./public-api";
import { retryVod, setProfile, setStreamer } from "./admin";
import { discord } from "./discord";
import { Twitch } from "./twitch";
import {
  clearDevStorage,
  handleJob,
  processPending,
  scheduled,
  type Job,
} from "./jobs";
import { catalogRoute } from "./platforms";
import { youtubeWebhook } from "./youtube-websub";
import { source, videoIdentity } from "./sources";
import { linkAppearances, unlinkAppearance } from "./appearances";
import { authRoute, authenticated } from "./auth";
import { socialRoute } from "./social";
import { publicImageVisible } from "./visibility";

async function eventsub(req: Request, env: Env) {
  const raw = await readText(req),
    id = req.headers.get("Twitch-Eventsub-Message-Id") || "",
    timestamp = req.headers.get("Twitch-Eventsub-Message-Timestamp") || "",
    signature = req.headers.get("Twitch-Eventsub-Message-Signature") || "";
  const age = Date.now() - Date.parse(timestamp);
  if (
    !id ||
    !Number.isFinite(age) ||
    age > 600_000 ||
    age < -60_000 ||
    !/^sha256=[a-f0-9]{64}$/.test(signature) ||
    !env.TWITCH_EVENTSUB_SECRET
  )
    return new Response("Invalid EventSub signature", { status: 403 });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.TWITCH_EVENTSUB_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const sig = new Uint8Array(
    signature
      .slice(7)
      .match(/../g)!
      .map((v) => parseInt(v, 16)),
  );
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      key,
      sig,
      new TextEncoder().encode(id + timestamp + raw),
    ))
  )
    return new Response("Invalid EventSub signature", { status: 403 });
  const payload = JSON.parse(raw),
    type = req.headers.get("Twitch-Eventsub-Message-Type");
  if (type === "webhook_callback_verification") {
    requireValue(typeof payload.challenge === "string", "Missing challenge");
    return new Response(payload.challenge);
  }
  if (type === "revocation")
    await statement(
      env,
      "UPDATE streamers SET eventsub_subscription_id=NULL WHERE eventsub_subscription_id=?",
      payload.subscription?.id,
    ).run();
  if (
    type === "notification" &&
    payload.subscription?.type === "stream.offline"
  ) {
    // Queue before acknowledging; duplicate delivery is safe because catalog/claims are idempotent.
    if (!(await one(env, "SELECT id FROM webhook_events WHERE id=?", id))) {
      const user = Number(payload.event?.broadcaster_user_id);
      integer(user, "broadcaster_user_id", 1);
      await env.JOBS.send({ type: "catalog", id: user });
      await statement(
        env,
        "INSERT OR IGNORE INTO webhook_events(id,created_at) VALUES(?,?)",
        id,
        now(),
      ).run();
    }
  }
  return new Response(null, { status: 204 });
}
async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url),
    path = url.pathname;
  if (path === "/health" && req.method === "GET") {
    await one(env, "SELECT 1");
    return Response.json({ ok: true, environment: env.ENVIRONMENT, build_commit: env.BUILD_COMMIT });
  }
  if (path === "/api/auth" || path.startsWith("/api/auth/")) return authRoute(req, env);
  if (path === "/api/v1/me" && req.method === "GET") return Response.json(await authenticated(req, env));
  if (path.startsWith("/api/v1/") || path.startsWith("/api/admin/social/")) return socialRoute(req, env);
  if (
    path.startsWith("/storage/v1/object/public/detections/") ||
    path.startsWith("/detections/")
  ) {
    if (!["GET", "HEAD"].includes(req.method))
      throw new HttpError(405, "Method not allowed");
    const key = decodeURIComponent(
      path
        .replace(/^\/storage\/v1\/object\/public\/detections\//, "")
        .replace(/^\/detections\//, ""),
    );
    if (!(await publicImageVisible(env, key))) throw new HttpError(404, "Screenshot not found");
    const object = await env.DETECTIONS.get(key);
    if (!object) throw new HttpError(404, "Screenshot not found");
    const headers = new Headers({
      "Cache-Control": "public,max-age=0,must-revalidate",
      "X-Content-Type-Options": "nosniff",
    });
    object.writeHttpMetadata(headers);
    headers.set("ETag", object.httpEtag);
    if (req.headers.get("If-None-Match") === object.httpEtag)
      return new Response(null, { status: 304, headers });
    return new Response(req.method === "HEAD" ? null : object.body, {
      headers,
    });
  }
  if (path.startsWith("/rest/v1/rpc/") && req.method === "POST") {
    const data = await body(req);
    return publicCache(
      req,
      env,
      async () =>
        Response.json(await rpc(env, path.slice("/rest/v1/rpc/".length), data)),
      JSON.stringify(data),
    );
  }
  if (path.startsWith("/rest/v1/") && req.method === "GET") {
    return publicCache(req, env, () =>
      publicRead(req, env, path.slice("/rest/v1/".length)),
    );
  }
  if (path === "/functions/v1/ghost-bot" && req.method === "POST")
    return discord(req, env);
  if (
    path === "/functions/v1/process-vod" &&
    req.method === "POST" &&
    req.headers.has("Twitch-Eventsub-Message-Type")
  )
    return eventsub(req, env);
  if (path === "/functions/v1/youtube-webhook") return youtubeWebhook(req, env);
  if (path.startsWith("/api/catalog/")) {
    if (!(await authorized(req, env.CATALOG_KEY))) throw new HttpError(401,"Unauthorized");
    return catalogRoute(req,env);
  }
  const processor = path.startsWith("/api/processor/");
  if (!(await authorized(req, processor ? env.PROCESSOR_KEY : env.ADMIN_KEY)))
    throw new HttpError(401, "Unauthorized");
  if (processor) {
    const prefix = "/api/processor";
    if (path === `${prefix}/vod` && req.method === "GET")
      return Response.json(
        await vodDetails(env, url.searchParams.get("source_id") || "", url.searchParams.get("source") || "twitch"),
      );
    if (path === `${prefix}/chunks` && req.method === "GET") {
      const vodId = integer(
        Number(url.searchParams.get("vod_id")),
        "vod_id",
        1,
      );
      const ids = url.searchParams.get("ids");
      const queuedAt = url.searchParams.get("queued_at");
      const parsed = ids ? JSON.parse(ids) : null;
      if (parsed) {
        requireValue(
          Array.isArray(parsed) && parsed.length <= 256,
          "Invalid chunk IDs",
        );
        parsed.forEach(uuid);
      }
      return Response.json(
        await rows(
          env,
          `SELECT id FROM chunks WHERE vod_id=? AND status IN('pending','queued') ${ids ? "AND id IN(SELECT value FROM json_each(?))" : ""} ${queuedAt ? "AND status='queued' AND queued_at=?" : ""} ORDER BY chunk_index`,
          vodId,
          ...(ids ? [ids] : []),
          ...(queuedAt ? [queuedAt] : []),
        ),
      );
    }
    if (path === `${prefix}/fail-queued` && req.method === "POST") {
      const input = await body(req);
      requireValue(
        Array.isArray(input.ids) && input.ids.length <= 256,
        "Invalid chunk IDs",
      );
      input.ids.forEach(uuid);
      if (!input.queued_at) return Response.json({ updated: 0 });
      requireValue(
        typeof input.queued_at === "string" &&
          Number.isFinite(Date.parse(input.queued_at)),
        "Invalid dispatch timestamp",
      );
      const result = await statement(
        env,
        `UPDATE chunks SET status='failed',attempt_count=attempt_count+1,last_error=?,updated_at=? WHERE id IN(SELECT value FROM json_each(?)) AND status='queued' AND queued_at=? RETURNING id`,
        String(input.error || "Runner preparation failed").slice(0, 2000),
        now(),
        JSON.stringify(input.ids),
        input.queued_at,
      ).all();
      return Response.json({ updated: result.results.length });
    }
    const match = path.match(
      /^\/api\/processor\/chunks\/([^/]+)(?:\/(claim|detections|images))?$/,
    );
    if (match) {
      const id = uuid(match[1]),
        action = match[2],
        token = req.headers.get("X-Claim-Token");
      if (!action && req.method === "GET") {
        const chunk = await one(
          env,
          "SELECT c.id,c.start_seconds,c.end_seconds,c.status,c.frames_processed,c.detections_count,c.last_error,c.attempt_count,c.started_at,c.completed_at,c.quality,v.id AS vod_pk,v.source,v.source_id AS vod_id,v.creator_name AS streamer FROM chunks c JOIN vod_processing_context v ON v.id=c.vod_id WHERE c.id=?",
          id,
        );
        if (!chunk) throw new HttpError(404, "Chunk not found");
        return Response.json(chunk);
      }
      if (action === "claim" && req.method === "POST") {
        const input = await body(req);
        return Response.json(
          await claim(env, id, input.queued_at ?? null, {
            profile: input.expected_profile, oldTemplates: input.expected_old_templates,
          }),
        );
      }
      if (!action && req.method === "PATCH")
        return Response.json(
          await updateChunk(env, id, token, await body(req)),
        );
      if (action === "images" && req.method === "PUT")
        return Response.json(
          await upload(
            env,
            req,
            id,
            Number(url.searchParams.get("timestamp")),
            url.searchParams.get("kind") || "detection",
          ),
        );
      if (action === "detections" && req.method === "POST")
        return Response.json(
          await publish(env, id, token, (await body(req)).detections),
        );
      if (action === "detections" && req.method === "DELETE")
        return Response.json(await clearChunk(env, id, token));
    }
    throw new HttpError(404, "Unknown processor endpoint");
  }
  if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
  const input = await body(req);
  if (path === "/api/admin/appearances/link") return Response.json(await linkAppearances(env,input));
  if (path === "/api/admin/appearances/unlink") return Response.json(await unlinkAppearance(env,input));
  if (path === "/api/admin/retry-vod")
    return Response.json(await retryVod(env, input));
  if (path === "/api/admin/streamer")
    return Response.json(await setStreamer(env, input));
  if (path === "/api/admin/profile")
    return Response.json(await setProfile(env, input));
  if (path === "/functions/v1/process-vod") {
    if (input.expected_environment != null && input.expected_environment !== env.ENVIRONMENT) throw new HttpError(409,"Environment mismatch");
    const platform = source(input.source ?? "twitch");
    requireValue(
      (input.vod_id == null) !== (input.source_id == null),
      "Provide one vod_id or source_id",
    );
    if (input.source_id != null) videoIdentity(platform, String(input.source_id));
    const vod =
      input.vod_id != null
        ? await one(
            env,
            "SELECT id FROM vods WHERE id=?",
            integer(input.vod_id, "vod_id", 1),
          )
        : await one(
            env,
            "SELECT id FROM vods WHERE source=? AND source_id=?",
            platform, String(input.source_id),
          );
    if (!vod) throw new HttpError(404, "VOD not found");
    requireValue(
      input.dry_run == null || typeof input.dry_run === "boolean",
      "Invalid dry_run",
    );
    const ids = input.dry_run
      ? (await plan(env, vod.id)).map((c) => c.id)
      : await dispatch(env, vod.id);
    return Response.json({
      success: true,
      vod_id: vod.id,
      chunks_found: ids.length,
      chunk_uuids: ids,
    });
  }
  if (path === "/functions/v1/schedule-vod-processing") {
    const action = input.action || "check_status";
    requireValue(
      ["check_status", "test_processing"].includes(action),
      "Invalid action",
    );
    if (action === "test_processing") await processPending(env);
    return Response.json({
      success: true,
      pending_vods: (await one(
        env,
        "SELECT count(*) AS n FROM vods WHERE status IN('pending','partial')",
      ))!.n,
    });
  }
  if (path === "/functions/v1/get_vods_from_streamer") {
    requireValue(
      input.dryRun == null || typeof input.dryRun === "boolean",
      "Invalid dryRun",
    );
    return Response.json(
      await new Twitch(env).catalog(
        integer(Number(input.streamerId), "streamerId", 1),
        undefined,
        input.dryRun === true,
      ),
    );
  }
  if (path === "/functions/v1/update-vods") {
    await env.JOBS.send({
      type: input.streamer_id != null ? "catalog" : "catalog-all",
      id:
        input.streamer_id == null
          ? undefined
          : integer(input.streamer_id, "streamer_id", 1),
    });
    return Response.json({ queued: true }, { status: 202 });
  }
  const tasks: Record<string, string> = {
    "/functions/v1/insert-new-streamers": "discover",
    "/functions/v1/check_vod_availability": "availability",
    "/functions/v1/search-chat-mentions": "chat-all",
  };
  if (tasks[path]) {
    await env.JOBS.send({ type: tasks[path] });
    return Response.json({ queued: true }, { status: 202 });
  }
  if (path === "/api/admin/clear-dev-storage") {
    await clearDevStorage(env);
    return Response.json({ success: true });
  }
  throw new HttpError(404, "Unknown endpoint");
}
export default {
  async fetch(req: Request, env: Env) {
    const path = new URL(req.url).pathname;
    const userRoute = path === "/api/auth" || path.startsWith("/api/auth/") || path.startsWith("/api/v1/");
    const origin = req.headers.get("Origin"),
      allowed = [...env.CORS_ORIGINS.split(",").map(value => value.trim()).filter(Boolean),
        new URL(env.PUBLIC_URL).origin].includes(origin || "");
    let response: Response;
    try {
      response =
        req.method === "OPTIONS"
          ? new Response(null, { status: 204 })
          : await route(req, env);
    } catch (error) {
      const status =
        error instanceof HttpError
          ? error.status
          : error instanceof SyntaxError
            ? 400
            : 500;
      if (status === 500) console.error(userRoute ? { event: "user_api_failed", path } : error);
      response = Response.json(
        {
          error:
            status === 500
              ? "Internal server error"
              : String((error as Error).message),
        },
        { status },
      );
    }
    const headers = new Headers(response.headers);
    const vary = new Set((headers.get("Vary") || "").split(",").map(value => value.trim()).filter(Boolean));
    vary.add("Origin");
    headers.set("Vary", [...vary].join(", "));
    headers.set("X-Content-Type-Options", "nosniff");
    if (userRoute) headers.set("Cache-Control", "no-store");
    if (allowed) {
      headers.set("Access-Control-Allow-Origin", origin!);
      headers.set("Access-Control-Allow-Methods", userRoute ? "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS" : "GET,HEAD,POST,OPTIONS");
      if (userRoute) headers.set("Access-Control-Allow-Credentials", "true");
      headers.set(
        "Access-Control-Allow-Headers",
        "authorization,apikey,content-type,x-client-info,range,prefer" + (userRoute ? ",x-csrf-token" : ""),
      );
      headers.set("Access-Control-Expose-Headers", "Content-Range");
    }
    return new Response(response.body, { status: response.status, headers });
  },
  scheduled,
  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        await handleJob(env, message.body as Job);
        message.ack();
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "job_failed",
            type: (message.body as Job).type,
            error: String(error),
          }),
        );
        message.retry({
          delaySeconds: Math.min(3600, 30 * 2 ** message.attempts),
        });
      }
    }
  },
} satisfies ExportedHandler<Env>;
