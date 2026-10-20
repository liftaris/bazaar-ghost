import { HttpError, requireValue } from "./http";
import { publicState } from "./visibility";

/** A short-lived result boundary; inserts cannot move existing pages. */
export interface Boundary {
  revision: number;
  matchups: number;
  recordings: number;
  expires: number;
}
interface Cursor extends Boundary {
  query: string;
  after: (string | number)[];
}
const encode = (value: Uint8Array) =>
  btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
function decode(value: string) {
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
}
async function signingKey(env: Env) {
  if (!env.ADMIN_KEY) throw new Error("Cursor signing key unavailable");
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`public-cursor-v1:${env.ADMIN_KEY}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
/** Binds a cursor to a canonical request, excluding page size and the cursor itself. */
function queryKey(url: URL) {
  const params = new URLSearchParams(url.search);
  params.delete("cursor");
  params.delete("limit");
  params.sort();
  return url.pathname + "?" + params.toString();
}
/** Read a signed cursor, or take a high watermark for a new search. */
export async function boundary(env: Env, url: URL): Promise<Cursor> {
  const token = url.searchParams.get("cursor"),
    query = queryKey(url);
  if (token) {
    try {
      requireValue(token.length <= 3000, "Invalid cursor");
      const parts = token.split(".");
      requireValue(parts.length === 2, "Invalid cursor");
      const bytes = decode(parts[0]);
      requireValue(
        await crypto.subtle.verify(
          "HMAC",
          await signingKey(env),
          decode(parts[1]),
          bytes,
        ),
        "Invalid cursor",
      );
      const value: Cursor = JSON.parse(new TextDecoder().decode(bytes));
      requireValue(
        value.query === query && Array.isArray(value.after),
        "Cursor belongs to another query",
      );
      if (value.expires < Date.now())
        throw new HttpError(409, "Results expired; refresh this search");
      await unchanged(env, value);
      return value;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "Invalid cursor");
    }
  }
  const { search, matchups, recordings } = await publicState(env);
  return { revision: search, matchups, recordings, expires: Date.now() + 900_000, query, after: [] };
}
/** Detect corrections during or between requests instead of silently skipping records.
 * `fresh` bypasses the short-lived revision memo; the final check of a request uses it.
 */
export async function unchanged(env: Env, value: Boundary, fresh = false) {
  if ((await publicState(env, fresh)).search !== value.revision)
    throw new HttpError(409, "Results changed; refresh this search");
}
/** Return a bounded page and sign its continuation without counting the whole result set. */
export async function page<T>(
  env: Env,
  value: Cursor,
  items: T[],
  limit: number,
  position: (item: T) => (string | number)[],
) {
  await unchanged(env, value);
  const selected = items.slice(0, limit);
  let nextCursor: string | null = null;
  if (items.length > limit) {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        ...value,
        after: position(selected[selected.length - 1]),
      }),
    );
    nextCursor = `${encode(bytes)}.${encode(new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(env), bytes)))}`;
  }
  return { items: selected, nextCursor };
}
