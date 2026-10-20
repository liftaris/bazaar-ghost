import { decodeRow, HttpError, integer, one, requireValue, rows } from "./http";
import { search } from "./search";
import { videoSearch, appearanceSearch } from "./appearances";
import { recordingUrls } from "./platform-registry";

// Deliberately bounded compatibility for this application's read-only PostgREST contracts.
const views = new Set([
  "video_detections",
  "streamers",
  "streamers_with_detections",
  "vod_stats",
  "vod_embed_info",
  "detection_search",
  "streamer_detection_stats",
]);
const privateColumns = new Set(["eventsub_subscription_id", "username_lower"]);
export async function publicRead(req: Request, env: Env, view: string) {
  if (!views.has(view)) throw new HttpError(404, "Unknown public resource");
  const columns = await rows(env, `PRAGMA table_info(${view})`);
  const allowed = new Set<string>(
    columns.map((c) => c.name).filter((n) => !privateColumns.has(n)),
  );
  // video_detections URLs are built from the platform registry, not stored in the view.
  const derived = view === "video_detections" ? ["video_url", "embed_url"] : [];
  const check = (field: string) => {
    requireValue(allowed.has(field), "Unknown column");
    return `"${field}"`;
  };
  const params = new URL(req.url).searchParams;
  const selected = params.get("select") || "*";
  const wanted = selected === "*" ? [...allowed, ...derived] : selected.split(",");
  const urlFields = ["frame_time_seconds", "source", "source_id", "source_video_id", "source_part_id", "source_part_index"];
  const stored = wanted.filter((field) => !derived.includes(field));
  const needsUrls = stored.length !== wanted.length;
  const projection = [...stored, ...(needsUrls ? urlFields.filter((field) => !stored.includes(field)) : [])]
    .map(check)
    .join(",");
  const clauses: string[] = [],
    bindings: unknown[] = [];
  const filter = (column: string, value: string) => {
    const dot = value.indexOf("."),
      op = value.slice(0, dot),
      term = value.slice(dot + 1);
    const operators: Record<string, string> = {
      eq: "=",
      gt: ">",
      gte: ">=",
      lt: "<",
      lte: "<=",
      ilike: "LIKE",
    };
    requireValue(Object.hasOwn(operators, op), "Unsupported filter");
    const type = columns.find((c) => c.name === column)?.type || "";
    const bound =
      op !== "ilike" && type !== "TEXT" && /^-?\d+(\.\d+)?$/.test(term)
        ? Number(term)
        : term;
    bindings.push(op === "ilike" ? term.replaceAll("*", "%") : bound);
    return `${check(column)} ${operators[op]} ?`;
  };
  for (const [key, value] of params) {
    if (["select", "order", "limit", "offset"].includes(key)) continue;
    if (key === "or") {
      const terms = value.replace(/^\(|\)$/g, "").split(",");
      requireValue(terms.length <= 10, "Too many filters");
      clauses.push(
        "(" +
          terms
            .map((t) => {
              const dot = t.indexOf(".");
              return filter(t.slice(0, dot), t.slice(dot + 1));
            })
            .join(" OR ") +
          ")",
      );
    } else clauses.push(filter(key, value));
  }
  const order = (params.get("order") || "")
    .split(",")
    .filter(Boolean)
    .map((term) => {
      const [column, direction = "asc"] = term.split(".");
      requireValue(
        ["asc", "desc"].includes(direction),
        "Invalid sort direction",
      );
      return `${check(column)} ${direction}`;
    })
    .join(",");
  const range = req.headers.get("range")?.match(/^(\d+)-(\d+)$/);
  const offset = integer(
    Number(params.get("offset") || range?.[1] || 0),
    "offset",
    0,
    100_000,
  );
  const limit = integer(
    Number(
      params.get("limit") ||
        (range ? Number(range[2]) - Number(range[1]) + 1 : 1000),
    ),
    "limit",
    1,
    1000,
  );
  const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
  const results = (
    await rows(
      env,
      `SELECT ${projection} FROM ${view}${where}${order ? " ORDER BY " + order : ""} LIMIT ? OFFSET ?`,
      ...bindings,
      limit,
      offset,
    )
  ).map(decodeRow).map((row) => {
    if (!needsUrls) return row;
    const urls: Record<string, unknown> = recordingUrls(row);
    const shaped: Record<string, unknown> = {};
    for (const field of wanted) shaped[field] = derived.includes(field) ? urls[field] : row[field];
    return shaped;
  });
  const count = (await one(
    env,
    `SELECT count(*) AS n FROM ${view}${where}`,
    ...bindings,
  ))!.n;
  const headers = {
    "Content-Range": `${results.length ? offset + "-" + (offset + results.length - 1) : "*"}/${count}`,
    "Range-Unit": "items",
  };
  if (
    req.headers.get("Accept")?.includes("application/vnd.pgrst.object+json")
  ) {
    if (results.length !== 1)
      return Response.json(
        {
          code: "PGRST116",
          message: "Expected exactly one row",
          details: `The result contains ${results.length} rows`,
        },
        { status: 406, headers },
      );
    return Response.json(results[0], { headers });
  }
  return Response.json(results, { headers });
}
export async function rpc(env: Env, name: string, input: Record<string, any>) {
  if (name === "search_video_detections") return videoSearch(env,input);
  if (name === "search_matchup_appearances") return appearanceSearch(env,input);
  if (name === "fuzzy_search_detections") return search(env, input);
  if (name === "get_global_stats")
    return one(
      env,
      `SELECT (SELECT count(*) FROM detection_search) AS matchups,(SELECT count(*) FROM streamers_with_detections) AS streamers,(SELECT count(DISTINCT vod_id) FROM detection_search) AS vods`,
    );
  if (name === "get_top_streamers_with_recent_detections") {
    const top = integer(input.top_count ?? 10, "top_count", 1, 50),
      per = integer(
        input.detections_per_streamer ?? 5,
        "detections_per_streamer",
        1,
        20,
      );
    return (
      await rows(
        env,
        `WITH top AS (SELECT * FROM streamers_with_detections ORDER BY detection_count DESC,streamer_id LIMIT ?), ranked AS (
      SELECT ds.*,t.detection_count AS total_detections,t.vod_count AS total_vods,row_number() OVER(PARTITION BY ds.streamer_id ORDER BY ds.actual_timestamp DESC,ds.detection_id) AS detection_row_num FROM detection_search ds JOIN top t ON t.streamer_id=ds.streamer_id)
      SELECT * FROM ranked WHERE detection_row_num<=? ORDER BY total_detections DESC,streamer_id,detection_row_num`,
        top,
        per,
      )
    ).map(({ username_lower, ...r }) => decodeRow(r));
  }
  throw new HttpError(404, "Unknown public RPC");
}
