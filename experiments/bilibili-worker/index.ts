// Read-only Bilibili listing probe. Requests only fixed public endpoints and
// returns status/code/item-count summaries, never bodies or cookie values.
// An honest client UA with the anonymous device cookie was accepted consistently;
// a browser UA without browser behavior was rejected (HTTP 412) on view.
const UA = "BazaarGhost/1.0";
const UIDS = ["1838389", "2561817", "19203673"];
const BVID = "BV1K114BiE7t";
const MAX_BYTES = 2_000_000;

type Step = { name: string; http: number | null; code: number | null; items: number | null; ms: number; error?: string };
let device: { cookie: string; at: number } | null = null;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function call(name: string, url: string, referer: string, cookie: string, count: (data: any) => number | null): Promise<Step> {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      redirect: "manual",
      headers: { "User-Agent": UA, Referer: referer, ...(cookie ? { Cookie: cookie } : {}) },
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.arrayBuffer();
    if (body.byteLength > MAX_BYTES) return { name, http: response.status, code: null, items: null, ms: Date.now() - started, error: "too_large" };
    let parsed: any = null;
    try { parsed = JSON.parse(new TextDecoder().decode(body)); } catch { /* HTML/empty rejection pages */ }
    const code = typeof parsed?.code === "number" ? parsed.code : null;
    return { name, http: response.status, code, items: code === 0 ? count(parsed.data) : null, ms: Date.now() - started };
  } catch (error) {
    return { name, http: null, code: null, items: null, ms: Date.now() - started, error: error instanceof Error ? error.name : "error" };
  }
}

async function bootstrap(steps: Step[]): Promise<string> {
  const started = Date.now();
  const response = await fetch("https://api.bilibili.com/x/frontend/finger/spi", {
    headers: { "User-Agent": UA, Referer: "https://www.bilibili.com/" }, signal: AbortSignal.timeout(20_000),
  });
  const data: any = await response.json().catch(() => null);
  const b3 = data?.data?.b_3, b4 = data?.data?.b_4;
  steps.push({ name: "spi", http: response.status, code: data?.code ?? null, items: null, ms: Date.now() - started });
  if (typeof b3 !== "string" || typeof b4 !== "string") return "";
  return `buvid3=${b3}; buvid4=${encodeURIComponent(b4)}; b_nut=${Math.floor(Date.now() / 1000)}`;
}

async function probe(gap: number, fresh: boolean) {
  const steps: Step[] = [];
  if (fresh || !device) {
    const cookie = await bootstrap(steps);
    device = cookie ? { cookie, at: Date.now() } : null;
    await sleep(gap);
  }
  const cookie = device?.cookie ?? "";
  const search = new URLSearchParams({ search_type: "video", keyword: "大巴扎", order: "pubdate", page: "1" });
  steps.push(await call("search", `https://api.bilibili.com/x/web-interface/search/type?${search}`, "https://search.bilibili.com/",
    cookie, data => Array.isArray(data?.result) ? data.result.length : null));
  for (const mid of UIDS) {
    await sleep(gap);
    const params = new URLSearchParams({ mid, keywords: "", ps: "50", pn: "1" });
    steps.push(await call(`uploader:${mid}`, `https://api.bilibili.com/x/series/recArchivesByKeywords?${params}`,
      `https://space.bilibili.com/${mid}/video`, cookie, data => Array.isArray(data?.archives) ? data.archives.length : null));
  }
  await sleep(gap);
  steps.push(await call("view", `https://api.bilibili.com/x/web-interface/view?bvid=${BVID}`, "https://www.bilibili.com/",
    cookie, data => Array.isArray(data?.pages) ? data.pages.length : null));
  await sleep(gap);
  steps.push(await call("card", `https://api.bilibili.com/x/web-interface/card?mid=${UIDS[0]}`, "https://www.bilibili.com/",
    cookie, data => (data?.card ? 1 : null)));
  return { steps, cookie_age_s: device ? Math.round((Date.now() - device.at) / 1000) : null };
}

export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    const url = new URL(request.url);
    if (env.PROBE_NETWORK === "local") {
      if (!["127.0.0.1", "localhost"].includes(url.hostname)) return new Response(null, { status: 403 });
    } else {
      if (!env.PROBE_TOKEN || !Number.isFinite(Number(env.PROBE_EXPIRES)) || Date.now() >= Number(env.PROBE_EXPIRES)) {
        return new Response(null, { status: 410 });
      }
      const token = request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
      const encoder = new TextEncoder();
      const [provided, expected] = await Promise.all([token, env.PROBE_TOKEN]
        .map(value => crypto.subtle.digest("SHA-256", encoder.encode(value))));
      if (!crypto.subtle.timingSafeEqual(provided, expected)) return new Response(null, { status: 401 });
    }
    if (request.method !== "GET") return new Response(null, { status: 405 });
    const network = { network: env.PROBE_NETWORK, colo: request.cf?.colo ?? null };
    if (url.pathname === "/health") return Response.json({ ok: true, experiment: "bilibili-probe", ...network });
    if (url.pathname !== "/probe") return new Response(null, { status: 404 });
    const gap = Math.min(5000, Math.max(500, Number(url.searchParams.get("gap") ?? 2000) || 2000));
    return Response.json({ ...network, at: new Date().toISOString(), ...(await probe(gap, url.searchParams.get("fresh") === "1")) });
  },
};
