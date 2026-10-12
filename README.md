# gtfs-collector

A Cloudflare Worker that periodically fetches GTFS-RT (realtime) vehicle position data for Lviv, Ukraine public transit and stores it in Cloudflare R2.

## What it does

- Cron fires every minute from ~04:00 to midnight Kyiv time (UTC+2); each fire polls the feed every 10s (six 10s steps) since Cloudflare Cron Triggers can't fire faster than once/minute
- Fetches a protobuf-encoded GTFS-RT feed from `track.ua-gis.com`
- Stores each snapshot to R2 at `raw/YYYY-MM-DD/YYYY-MM-DDTHH:mm:ss.pb`
- Skips writing a snapshot if the feed's header timestamp is unchanged since the last written snapshot (avoids storing duplicate data when the upstream feed hasn't updated yet). This holds across cron fires while Cloudflare reuses the worker isolate; a fresh isolate writes its first snapshot unconditionally
- Attaches `entityCount`, `feedTimestamp`, and `bytes` as R2 custom metadata on each object
- Warns via Sentry (at most once per cron fire) if the feed is unreachable or its header timestamp is more than 5 minutes stale
- Silently skips the 00:00–04:00 window (low transit activity)
- A second, once-daily cron archives the **GTFS static** feed (schedule data — routes, trips, stop_times, calendar) to `static/YYYY-MM-DD/static.zip`, skipping the write when a HEAD request's ETag/Last-Modified shows it hasn't changed since the last archived copy. Static rarely changes, but downstream consumers that score/train against past days need the schedule that was actually in effect that day, not whatever is current.

## Setup

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com) with Workers and R2 enabled
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) installed

### Deploy

```sh
npx wrangler deploy
```

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
| `r2_buckets[].bucket_name` | `gtfs-lviv` | R2 bucket for raw snapshots |
| `triggers.crons` | `* 1-21 * * *` | UTC schedule; runtime guard gates the 04:00 Kyiv start across DST; worker polls every 10s (six 10s steps per fire) |
| `analytics_engine_datasets[].binding` | `ANALYTICS` (commented out) | Optional per-poll metrics (payload size, entity count) via Workers Analytics Engine. Requires a Workers Paid plan; uncomment to enable, the worker no-ops if unbound |

## HTTP endpoints

The worker also responds to HTTP for manual triggering and inspection:

| Path | Description |
|------|-------------|
| `GET /` | Trigger a collection immediately and return `ok` |
| `GET /health` | Health check; `200` if healthy, `503` otherwise. `status` is `stale` when no snapshot was uploaded in the last 3 min, `feed_stale` when uploads are fresh but the latest snapshot's feed header timestamp is >5 min old (upstream frozen), `ok` otherwise or during off-hours. Response includes `age_seconds` (upload) and `feed_age_seconds` (feed header) |
| `GET /latest` | Metadata (key, size, age, custom metadata) for the most recent snapshot; add `?raw` to stream the `.pb` bytes directly |
| `GET /stats?date=YYYY-MM-DD` | Snapshot count, total/average bytes, and largest gap between snapshots for a day (defaults to today), plus `by_hour_kyiv`: snapshot count per Kyiv hour `"00:00"`–`"23:00"`, in chronological order (zeros show outages) |
| `GET /list` | List objects in R2. Optional `?date=YYYY-MM-DD` (prefix filter), `?limit=N` (default 20, max 1000), `?cursor=...` for pagination; response includes a `cursor` for the next page when truncated |
| `GET /static` | Trigger a static-feed archive check immediately and return `ok` |
| `GET /static/list` | Archived static snapshots, oldest first: `date`, `key`, `size`, `uploaded`, `etag`, `lastModified`. Optional `?limit=N` (default 100, max 1000) and `?cursor=...`; response includes a `cursor` for the next page when truncated |
| `GET /static/latest` | Metadata (key, etag, lastModified, bytes, sha256, date) for the most recently archived static snapshot |

`/favicon.ico` and `/robots.txt` return `404`; any other path triggers a collection like `GET /`.

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

## Feed source

- `https://track.ua-gis.com/gtfs/lviv/vehicle_position` — Lviv public transit GTFS-RT vehicle positions.
- `https://track.ua-gis.com/gtfs/lviv/static.zip` — Lviv public transit GTFS static (schedule) feed.
