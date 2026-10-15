# gtfs-collector

A Cloudflare Worker that periodically fetches GTFS-RT (realtime) vehicle position data for Lviv, Ukraine public transit and stores it in Cloudflare R2.

## What it does

- Cron fires every minute from 04:00 to midnight Kyiv local time (UTC+2 winter / UTC+3 summer); each fire polls the feed every 10s (six 10s steps) since Cloudflare Cron Triggers can't fire faster than once/minute
- Fetches a protobuf-encoded GTFS-RT feed from `track.ua-gis.com`
- Stores each snapshot to R2 at `raw/YYYY-MM-DD/YYYY-MM-DDTHH:mm:ss.pb`
- Skips writing a snapshot if the feed's header timestamp is unchanged since the last written snapshot (avoids storing duplicate data when the upstream feed hasn't updated yet). This holds across cron fires while Cloudflare reuses the worker isolate; a fresh isolate writes its first snapshot unconditionally
- Attaches `feedTimestamp` and `bytes` as R2 custom metadata on each object
- Warns via Sentry (at most once per cron fire) if the feed is unreachable or its header timestamp is more than 5 minutes stale
- Retries transient failures (feed fetch, R2 put, R2 list) with exponential backoff and times out hung requests; see [Reliability](#reliability)
- Silently skips the 00:00–04:00 window (low transit activity)
- A second, once-daily cron archives the **GTFS static** feed (schedule data — routes, trips, stop_times, calendar) to `static/YYYY-MM-DD/static.zip`, skipping the write when it hasn't changed since the last archived copy (ETag/Last-Modified from a HEAD request, with a SHA-256 content check as fallback). Static rarely changes, but downstream consumers that score/train against past days need the schedule that was actually in effect that day, not whatever is current.

## Setup

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com) with Workers and R2 enabled
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) installed

### Deploy

```sh
make deploy        # nvm use (Node from .nvmrc) + npx wrangler deploy
# or: npx wrangler deploy
```

Nothing deploys automatically on merge (no CI workflow); deploy by hand after merging to `main`.

The R2 bucket `gtfs-lviv` must exist before deploying. Create it in the Cloudflare dashboard or via Wrangler:

```sh
npx wrangler r2 bucket create gtfs-lviv
```

## Configuration

All config lives in [wrangler.toml](wrangler.toml):

| Key | Value | Notes |
|-----|-------|-------|
| `name` | `gtfs-collector` | Worker name |
| `main` | `src/worker.js` | Entry point |
| `r2_buckets[].bucket_name` | `gtfs-lviv` | R2 bucket for realtime snapshots and static archives |
| `triggers.crons` | `* 1-21 * * *` | Realtime collection. UTC schedule; runtime guard gates the 04:00 Kyiv start across DST; worker polls every 10s (six 10s steps per fire) |
| `triggers.crons` | `0 2 * * *` | Static archive, once a day (must match `STATIC_CRON` in `src/worker.js`) |
| `analytics_engine_datasets[].binding` | `ANALYTICS` (commented out) | Optional per-poll metrics (payload size, entity count) via Workers Analytics Engine. Requires a Workers Paid plan; uncomment to enable, the worker no-ops if unbound |

### Secrets and variables

All optional; the worker runs without any of them. Set secrets with `npx wrangler secret put <NAME>`.

| Name | Purpose |
|------|---------|
| `SENTRY_DSN` | Sentry project DSN. Unset: nothing is reported |
| `SENTRY_ENVIRONMENT` | Sentry `environment` tag (default `production`) |
| `ADMIN_TOKEN` | Protects the endpoints that write to R2 (see [HTTP endpoints](#http-endpoints)). Unset: they are public |

## HTTP endpoints

The worker also responds to HTTP for manual triggering and inspection:

| Path | Description |
|------|-------------|
| `GET /` | Trigger a collection immediately and return `ok` |
| `GET /health` | Health check; `200` if healthy, `503` otherwise. `status` is `stale` when no snapshot was uploaded in the last 3 min, `feed_stale` when uploads are fresh but the latest snapshot's feed header timestamp is >5 min old (upstream frozen), `ok` otherwise or during off-hours. Response includes `age_seconds` (upload) and `feed_age_seconds` (feed header) |
| `GET /latest` | Metadata (key, size, age, custom metadata) for today's most recent snapshot, `404` if none today; add `?raw` to stream the `.pb` bytes directly |
| `GET /stats?date=YYYY-MM-DD` | Snapshot count, total/average bytes, and largest gap between snapshots for a day (defaults to today), plus `by_hour_kyiv`: snapshot count per Kyiv hour `"00:00"`–`"23:00"`, in chronological order (zeros show outages) |
| `GET /list` | List objects in R2. Optional `?date=YYYY-MM-DD` (prefix filter), `?limit=N` (default 20, max 1000), `?cursor=...` for pagination; response includes a `cursor` for the next page when truncated |
| `GET /static` | Trigger a static-feed archive check immediately and return `ok` |
| `GET /static/list` | Archived static snapshots, oldest first: `date`, `key`, `size`, `uploaded`, `etag`, `lastModified`. Optional `?limit=N` (default 100, max 1000) and `?cursor=...`; response includes a `cursor` for the next page when truncated |
| `GET /static/latest` | Metadata (key, etag, lastModified, bytes, sha256, date) for the most recently archived static snapshot |

`/favicon.ico` and `/robots.txt` return `404`; any other path triggers a collection like `GET /`. Dates are UTC days (the `raw/` prefix); a malformed `?date` just matches nothing.

`GET /`, `GET /static` and any unlisted path write to R2. If the `ADMIN_TOKEN` secret is set (`npx wrangler secret put ADMIN_TOKEN`), they require `Authorization: Bearer <token>` (or `?token=<token>`) and return `401` otherwise; read-only endpoints stay open. Unset, they are public as before.

## Data layout

```
raw/
  2025-06-07/
    2025-06-07T04:00:01.000Z.pb
    2025-06-07T04:01:00.123Z.pb
    ...
static/
  2026-07-02/
    static.zip
  2026-07-15/
    static.zip
  _latest.json   # {etag, lastModified, bytes, sha256, key, date} of the most recent archived copy
```

Each `.pb` file is a raw GTFS-RT `FeedMessage` protobuf, content-type `application/x-protobuf`. Each `static.zip` is the upstream GTFS static feed unmodified; a new dated copy only appears when it actually changed (ETag/Last-Modified, falling back to the body's SHA-256 when the server sends no validators or they change without the content changing). A response that isn't a zip archive is rejected rather than archived.

## Reliability

| What | Behavior |
|------|----------|
| Realtime feed fetch | Up to 5 attempts, backoff 400ms → 3.2s, 5s timeout per attempt. A 200 body that isn't a GTFS-RT `FeedMessage` counts as a failure |
| Static feed fetch | 60s timeout. A failed or unsupported HEAD falls through to the GET; a non-zip body is rejected |
| R2 `put` | Up to 3 attempts (transient `10001` internal errors) |
| R2 `list` | Up to 3 attempts (`10058` concurrent-request rate limits when an HTTP request overlaps a cron fire) |
| Failed snapshot write | Not marked as stored, so the next poll retries the same feed instead of skipping it as a duplicate |

### Sentry events

Every event carries `service: gtfs-collector`, plus:

| Tag | Meaning |
|-----|---------|
| `stage: fetch_feed` | Realtime feed unavailable after all retries; `feed_failure` is `http_<status>`, `network_error` (incl. timeout) or `invalid_body` |
| `stage: stale_feed` | Feed header timestamp more than 5 min old |
| `stage: collect` | Unexpected error while collecting (e.g. R2 put failed after retries) |
| `stage: fetch_static` | Static feed GET failed or returned a non-zip body |
| `stage: collect_static` | Unexpected error while archiving static |
| `handler: fetch`, `path` | Unhandled error in an HTTP endpoint (returns `500`) |

## Cost

Rough R2 operation counts, all well within the free tier (Class A 1M/month, Class B 10M/month):

| Source | Operations |
|--------|------------|
| Realtime collection | ≤ 6 `put`s per minute, 04:00–24:00 Kyiv: ≤ ~7,200/day, ~220k/month (Class A). Duplicates of an unchanged feed are skipped |
| Static archive | 1 `get` of the marker per day; a `put` only when the feed changed |
| `/health`, `/latest` | 1–4 `list` (Class A) + 1 `head`/`get` (Class B) per call |
| `/stats` | 1 `list` per 1,000 snapshots of the day (≤ 10) |
| `/list`, `/static/list` | 1 `list` per call |

Storage grows by one day of snapshots per day; nothing is deleted automatically.

## Development

Requires Node 26 (`.nvmrc`; `engine-strict` is on).

```sh
make install    # nvm use + npm install
npm test        # vitest in the Workers runtime (@cloudflare/vitest-plugin)
npm run dev     # wrangler dev
```

## Tools

- [`tools/day-video`](tools/day-video/README.md): renders a timelapse video of one day of Lviv transport from the snapshots in R2.

## Feed source

- `https://track.ua-gis.com/gtfs/lviv/vehicle_position` — Lviv public transit GTFS-RT vehicle positions.
- `https://track.ua-gis.com/gtfs/lviv/static.zip` — Lviv public transit GTFS static (schedule) feed.
