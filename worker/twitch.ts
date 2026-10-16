import { external, now, one, requireValue, rows, statement } from "./http";
import { extractBazaarChapters } from "./chapters";
import { VOD_QUERY } from "./twitch-query";

export interface CatalogStats {
  total: number;
  bazaar: number;
  oldest: string | null;
}

export interface VideoChapter {
  positionMilliseconds: number;
  game?: { id: string; name: string };
}
export class Twitch {
  private token?: string;
  constructor(private env: Env) {}
  async helix(
    endpoint: string,
    params: Record<string, string> | URLSearchParams = {},
    method = "GET",
    body?: unknown,
  ): Promise<any> {
    if (!this.token) {
      const response = await external(
        this.env,
        "https://id.twitch.tv/oauth2/token",
        {
          method: "POST",
          body: new URLSearchParams({
            client_id: this.env.TWITCH_CLIENT_ID,
            client_secret: this.env.TWITCH_CLIENT_SECRET,
            grant_type: "client_credentials",
          }),
        },
      );
      this.token = (await response.json<any>()).access_token;
    }
    const response = await external(
      this.env,
      `https://api.twitch.tv/helix/${endpoint}?${new URLSearchParams(params)}`,
      {
        method,
        headers: {
          "Client-Id": this.env.TWITCH_CLIENT_ID,
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      },
    );
    return response.json();
  }
  async gql(query: string, variables: Record<string, unknown>): Promise<any> {
    const response = await external(this.env, "https://gql.twitch.tv/gql", {
      method: "POST",
      headers: {
        "Client-ID": "kimne78kx3ncx6brgo4mv6wki5h1ko",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    const result = await response.json<any>();
    if (result.errors?.length)
      throw new Error(`Twitch GraphQL error: ${result.errors[0].message}`);
    if (!result.data) throw new Error("Missing Twitch GraphQL data");
    return result.data;
  }
  async gameId(): Promise<string> {
    const games = await this.helix("search/categories", {
      query: "The Bazaar",
      first: "10",
    });
    const game = games.data?.find(
      (g: any) => g.name.toLowerCase() === "the bazaar",
    );
    if (!game) throw new Error("The Bazaar game not found");
    return game.id;
  }
  async ensureSubscription(id: number) {
    const streamer = await one(
      this.env,
      "SELECT processing_enabled,eventsub_subscription_id FROM streamers WHERE id=?",
      id,
    );
    if (!streamer?.processing_enabled || streamer.eventsub_subscription_id)
      return;
    requireValue(
      this.env.PUBLIC_URL.startsWith("https://"),
      "EventSub requires a public HTTPS callback",
    );
    const callback = `${this.env.PUBLIC_URL}/functions/v1/process-vod`;
    let cursor: string | undefined;
    do {
      const result = await this.helix("eventsub/subscriptions", {
        type: "stream.offline",
        user_id: String(id),
        ...(cursor ? { after: cursor } : {}),
      });
      const matching = result.data?.find(
        (s: any) =>
          s.condition.broadcaster_user_id === String(id) &&
          s.transport.callback === callback &&
          ["enabled", "webhook_callback_verification_pending"].includes(
            s.status,
          ),
      );
      if (matching) {
        await statement(
          this.env,
          "UPDATE streamers SET eventsub_subscription_id=? WHERE id=?",
          matching.id,
          id,
        ).run();
        return;
      }
      cursor = result.pagination?.cursor;
    } while (cursor);
    const result = await this.helix("eventsub/subscriptions", {}, "POST", {
      type: "stream.offline",
      version: "1",
      condition: { broadcaster_user_id: String(id) },
      transport: {
        method: "webhook",
        callback,
        secret: this.env.TWITCH_EVENTSUB_SECRET,
      },
    });
    if (!result.data?.[0]?.id)
      throw new Error("Missing EventSub subscription ID");
    await statement(
      this.env,
      "UPDATE streamers SET eventsub_subscription_id=? WHERE id=?",
      result.data[0].id,
      id,
    ).run();
  }
  async syncUser(user: any) {
    await statement(
      this.env,
      `INSERT INTO streamers(id,login,display_name,profile_image_url) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET login=excluded.login,display_name=excluded.display_name,profile_image_url=excluded.profile_image_url,updated_at=?`,
      Number(user.id),
      user.login.toLowerCase(),
      user.display_name,
      user.profile_image_url,
      now(),
    ).run();
  }
  async discover(cursor?: string, pageNumber = 0) {
    requireValue(Number.isInteger(pageNumber) && pageNumber >= 0 && pageNumber < 5, "Invalid discovery page");
    const page = await this.helix("videos", {
      game_id: await this.gameId(),
      first: "100",
      type: "archive",
      sort: "time",
      ...(cursor ? { after: cursor } : {}),
    });
    const scope = await one(this.env, "SELECT value FROM processing_config WHERE key='twitch_discovery_streamer_ids'");
    const allowed: unknown = scope ? JSON.parse(scope.value) : null;
    requireValue(allowed === null || (Array.isArray(allowed) && allowed.every(id => typeof id === 'string' && /^\d+$/.test(id))), "Invalid Twitch discovery scope");
    const ids = [
      ...new Set<string>((page.data || []).map((s: any) => s.user_id)),
    ].filter(id => allowed === null || (allowed as string[]).includes(id));
    if (ids.length) {
      const users = await this.helix(
        "users",
        new URLSearchParams(ids.map((id) => ["id", id])),
      );
      for (const user of users.data) {
        await this.syncUser(user);
        // Catalog immediately: an offline streamer may not emit another event
        // soon. Cataloging also ensures the stream.offline subscription.
        await this.env.JOBS.send({ type: "catalog", id: Number(user.id) });
      }
    }
    if (page.pagination?.cursor && pageNumber < 4) {
      requireValue(page.pagination.cursor !== cursor, "Discovery pagination did not advance");
      await this.env.JOBS.send({
        type: "discover",
        cursor: page.pagination.cursor,
        page: pageNumber + 1,
      });
    }
    return { streamersChecked: ids.length };
  }
  async catalog(
    id: number,
    cursor?: string,
    dryRun = false,
    prior: CatalogStats = { total: 0, bazaar: 0, oldest: null },
  ) {
    const users = await this.helix("users", { id: String(id) }),
      user = users.data?.[0];
    if (!user) throw new Error("Twitch user not found");
    if (!dryRun) await this.syncUser(user);
    const live =
      (await this.helix("streams", { user_id: String(id) })).data?.length > 0;
    const result = await this.gql(VOD_QUERY, {
      login: user.login,
      first: 100,
      after: cursor ?? null,
    });
    if (!result.user?.videos) throw new Error("Missing Twitch video listing");
    const game = await this.gameId(),
      edges = result.user.videos.edges;
    let count = 0;
    const stats = { ...prior };
    for (const [index, edge] of edges.entries()) {
      if (!cursor && live && index === 0) continue;
      const v = edge.node;
      stats.total++;
      const published = new Date(v.publishedAt).toISOString();
      stats.oldest =
        stats.oldest && stats.oldest < published ? stats.oldest : published;
      if (!v.moments?.edges)
        throw new Error(`Missing chapter evidence for ${v.id}`);
      if (v.moments.edges.length >= 25)
        throw new Error(`VOD ${v.id} reached the 25-chapter query limit`);
      const chapters = v.moments.edges.map((e: any) => ({
        positionMilliseconds: e.node.positionMilliseconds,
        game: e.node.details?.game,
      }));
      let ranges = extractBazaarChapters(chapters, v.lengthSeconds, game);
      if (
        !chapters.length &&
        (v.game?.id === game || v.game?.name?.toLowerCase() === "the bazaar")
      )
        ranges = [0, v.lengthSeconds];
      if (!ranges.length || v.lengthSeconds <= 0) continue;
      count++;
      stats.bazaar++;
      if (!dryRun)
        await statement(
          this.env,
          `INSERT INTO vods(streamer_id,source_id,title,duration_seconds,published_at,bazaar_chapters,ready_for_processing,last_availability_check) VALUES(?,?,?,?,?,?,1,?) ON CONFLICT(source,source_id) DO UPDATE SET title=excluded.title,duration_seconds=excluded.duration_seconds,published_at=excluded.published_at,bazaar_chapters=excluded.bazaar_chapters,ready_for_processing=1,availability='available',unavailable_since=NULL,last_availability_check=excluded.last_availability_check,updated_at=?`,
          id,
          v.id,
          v.title,
          v.lengthSeconds,
          new Date(v.publishedAt).toISOString(),
          JSON.stringify(ranges),
          now(),
          now(),
        ).run();
    }
    if (!dryRun) {
      for (const edge of edges) {
        const v = await one(
          this.env,
          "SELECT id FROM vods WHERE source='twitch' AND source_id=?",
          edge.node.id,
        );
        if (v) await this.env.JOBS.send({ type: "plan", id: v.id });
      }
      if (result.user.videos.pageInfo.hasNextPage) {
        requireValue(
          result.user.videos.pageInfo.endCursor !== cursor,
          "Twitch pagination did not advance",
        );
        await this.env.JOBS.send({
          type: "catalog",
          id,
          cursor: result.user.videos.pageInfo.endCursor,
          catalogStats: stats,
        });
      }
      if (!result.user.videos.pageInfo.hasNextPage) {
        await statement(
          this.env,
          "UPDATE streamers SET num_vods=?,num_bazaar_vods=?,has_vods=?,oldest_vod=?,updated_at=? WHERE id=?",
          stats.total,
          stats.bazaar,
          stats.total > 0,
          stats.oldest,
          now(),
          id,
        ).run();
      }
      await this.ensureSubscription(id);
    }
    return {
      streamerId: id,
      streamerLogin: user.login,
      dryRun,
      vodsDiscovered: edges.length,
      vodsInserted: dryRun ? 0 : count,
      vodsWouldBeInserted: dryRun ? count : undefined,
    };
  }
  async availability(after = 0) {
    const batch = await rows(
      this.env,
      "SELECT id,source_id FROM vods WHERE source='twitch' AND id>? AND availability!='unavailable' ORDER BY id LIMIT 100",
      after,
    );
    if (!batch.length) return;
    const result = await this.helix(
      "videos",
      new URLSearchParams(batch.map((v) => ["id", v.source_id])),
    );
    if (!Array.isArray(result.data))
      throw new Error("Invalid Twitch videos response");
    const available = new Set(result.data.map((v: any) => v.id));
    await this.env.DB.batch(
      batch.map((v) =>
        statement(
          this.env,
          "UPDATE vods SET availability=?,unavailable_since=?,last_availability_check=? WHERE id=?",
          available.has(v.source_id) ? "available" : "unavailable",
          available.has(v.source_id) ? null : now(),
          now(),
          v.id,
        ),
      ),
    );
    if (batch.length === 100)
      await this.env.JOBS.send({
        type: "availability",
        after: batch.at(-1)!.id,
      });
  }
}
