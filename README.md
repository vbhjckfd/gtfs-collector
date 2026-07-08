# gtfs-collector

A Cloudflare Worker that periodically fetches GTFS-RT (realtime) vehicle position data for Lviv, Ukraine public transit and stores it in Cloudflare R2.

## What it does

- Cron fires every minute from ~04:00 to midnight Kyiv time (UTC+2); each fire polls the feed every 10s (six 10s steps) since Cloudflare Cron Triggers can't fire faster than once/minute
- Fetches a protobuf-encoded GTFS-RT feed from `track.ua-gis.com`
- Stores each snapshot to R2 at `raw/YYYY-MM-DD/YYYY-MM-DDTHH:mm:ss.pb`
- Skips writing a snapshot if the feed's header timestamp is unchanged since the previous poll (avoids storing duplicate data when the upstream feed hasn't updated yet)
- Attaches `entityCount`, `feedTimestamp`, and `bytes` as R2 custom metadata on each object
- Warns via Sentry (at most once per cron fire) if the feed is unreachable or its header timestamp is more than 5 minutes stale
- Silently skips the 00:00–04:00 window (low transit activity)

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
| `GET /health` | Health check based on freshness of the latest snapshot; `200` if healthy, `503` if stale |
| `GET /latest` | Metadata (key, size, age, custom metadata) for the most recent snapshot; add `?raw` to stream the `.pb` bytes directly |
| `GET /stats?date=YYYY-MM-DD` | Snapshot count, total/average bytes, and largest gap between snapshots for a day (defaults to today) |
| `GET /list` | List objects in R2. Optional `?date=YYYY-MM-DD` (prefix filter), `?limit=N` (default 20, max 1000), `?cursor=...` for pagination; response includes a `cursor` for the next page when truncated |

## Data layout

```
raw/
  2025-06-07/
    2025-06-07T04:00:01.000Z.pb
    2025-06-07T04:01:00.123Z.pb
    ...
```

Each `.pb` file is a raw GTFS-RT `FeedMessage` protobuf, content-type `application/x-protobuf`.

## Feed source

`https://track.ua-gis.com/gtfs/lviv/vehicle_position` — Lviv public transit GTFS-RT vehicle positions.
