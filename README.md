# gtfs-collector

A Cloudflare Worker that periodically fetches GTFS-RT (realtime) vehicle position data for Lviv, Ukraine public transit and stores it in Cloudflare R2.

## What it does

- Runs every minute from ~04:00 to midnight Kyiv time (UTC+2), triggered by a Cloudflare Cron
- Fetches a protobuf-encoded GTFS-RT feed from `track.ua-gis.com`
- Stores each snapshot to R2 at `raw/YYYY-MM-DD/YYYY-MM-DDTHH:mm:ss.pb`
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
| `triggers.crons` | `* 2-21 * * *` | UTC schedule (≈ 04:00–23:00 Kyiv) |

## HTTP endpoints

The worker also responds to HTTP for manual triggering and inspection:

| Path | Description |
|------|-------------|
| `GET /` | Trigger a collection immediately and return `ok` |
| `GET /list` | List the 20 most recent objects in R2 |

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
