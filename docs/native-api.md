# Native public API

The browser uses same-origin `/api/v1/*` endpoints. The frontend Worker forwards
them to the backend through its `BACKEND` service binding. D1, R2, authentication,
moderation and processing remain owned by the backend; OCR stays in GitHub Actions.
The existing read-only `/rest/v1/*` and RPC contracts remain available during migration.

## Read contracts

| GET endpoint | Parameters | Response |
| --- | --- | --- |
| `/api/v1/search` | `type=matchups`, `q`, `source`, `creatorId`, `videoId`, `limit`, `cursor` | Matchup cards |
| `/api/v1/creators` | `q`, `source`, `creatorId`, `limit`, `cursor` | Creator accounts |
| `/api/v1/videos` | `q`, `source`, `creatorId`, `hasMatchups`, `limit`, `cursor` | Unique video cards, newest internal ID first |
| `/api/v1/videos/:id/playback` | none | Video, platform player URLs, chapters, processing coverage and first timeline page |
| `/api/v1/videos/:id/timeline` | `limit`, `cursor` | Compact markers ordered by timestamp and stable ID |
| `/api/v1/matchups/:id` | none | Current evidence at a durable anchor and verified alternate appearances |
| `/api/v1/stats` | none | Public creator, video and matchup counts |
| `/api/v1/videos/resolve` | `source`, `sourceId` | Resolve an external platform video ID |
| `/api/v1/creators/resolve` | `source=twitch`, `name` | Resolve old Twitch creator links; ambiguous names return 409 |
| `/api/v1/creators/quality` | `limit`, `cursor` | Public low-confidence summary for the existing help page |

`source` is `twitch`, `youtube` or `bilibili`. Creator IDs qualify the platform:
`twitch:<streamer ID>` or `<platform>:<platform account UUID>`. Video IDs and matchup
IDs are internal integers. Display names and OCR usernames are not identifiers.

Pages return `{items, nextCursor}` with no exact total. Default page size is 50,
maximum 100. A playback response starts with 100 timeline markers; follow its cursor
on the timeline endpoint until null. Counts on video cards are explicit;
`matchupCount: null` in embedded search videos means that count was not requested.

Search ranks exact normalized names first, then trigram similarity (minimum 0.25),
index time and stable ID. Search relevance and OCR confidence are separate fields.
Signed cursors bind the filters and ordering, expire after 15 minutes, and carry a
high watermark excluding new publications. Corrections invalidate a continuation
with HTTP 409; clients restart once and show a retryable error if the refresh fails.
This is a bounded result set, not a retained historical database snapshot.

## Identity and visibility

Matchup IDs reuse `clips.id`, anchored to `(vod_id, anchor_seconds)`. Replacing OCR
at the same timestamp preserves that ID and existing social records. A different
timestamp is a different anchor; no fuzzy identity merging is performed. If current
evidence is missing, hidden, below publication confidence, or unavailable, the
matchup endpoint returns 404. Publishing replacement evidence restores the same ID.

Verified groups now use `clip_appearances`, backfilled from existing reviewed links.
They survive deletion/replacement of OCR rows. The compatibility grouping API also
reads these durable relationships. Grouping still requires explicit review.

Public payloads use the existing 30-second internal cache behind primary-D1
visibility and correction revision checks. New publication watermarks also enter
the native cache key. Authentication and personal social state are never included.
Browser/gateway responses require fresh backend handling; screenshot delivery retains
the current publication check. Do not place an independent long-lived cache or image
optimizer in front of moderated content without a matching invalidation policy.

Completed coverage includes only completed chunks, not archived chunks. Remaining
coverage is the eligible Bazaar ranges minus completed coverage; an empty result
does not imply the entire video has been processed.

## Frontend and rollout

`contracts/public-api.ts` is the authoritative public response contract. Regenerate
the standalone frontend types and typed fetch client after changes:

```sh
python3 scripts/generate_frontend_api.py --output /path/to/bazaarghost.stream
python3 scripts/generate_frontend_api.py --output /path/to/bazaarghost.stream --check
```

The frontend's `BACKEND_WORKER` build/deploy variable selects the bound Worker;
the migration default is `bazaarghost-validation`. Apply backend migration 0009 and
deploy the backend before deploying the adapted frontend. No Supabase backfill or
production cutover is part of this API rollout.

From the frontend repository, `npm run deploy:validation` builds in validation mode
and deploys with cf to `bazaarghost-frontend-validation`. This mode binds only to
`bazaarghost-validation` and has no custom domains. The existing default frontend
deployment targets the live site; use the explicit validation command during this
parallel rollout.

For frontend development against an already deployed backend, explicitly opt into
the hosted service binding with `BACKEND_REMOTE=true npm run dev` (requires a valid
Cloudflare CLI login). Omit that variable when testing both Workers locally.

New frontend links use `/matchups/:id` and `/videos/:id`. Matchup pages recheck current
visibility on the server, provide share metadata, and hydrate the player from that
same response instead of repeating the matchup fetch in the browser. Old Twitch links resolve
through the native API; a legacy username occurrence that no longer exists shows an
error rather than choosing an unrelated timestamp. Platform embeds use the original
source ID, never the internal video ID. Twitch uses its existing player controls;
YouTube/Bilibili use their embedded players' own controls.

Before enabling same-origin login, configure the backend's `PUBLIC_URL` to the
frontend origin and update OAuth callback URLs to that origin's `/api/auth/callback/*`.
The gateway preserves Origin, cookies, CSRF headers and redirects; it supplies no
administrative key and does not bypass backend authorization. Better Auth and the
existing private social endpoints are unchanged.

The cf CLI and Vite plugin versions currently installed use different local Worker
registries. For a combined local test, register the backend as a Vite auxiliary
Worker with `devOnly: true`, local bindings and isolated persistence, rather than
assuming separately started dev servers discover each other. Hosted service bindings
do not use these local registries.
