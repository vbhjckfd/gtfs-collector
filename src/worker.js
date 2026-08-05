const FEED_URL = "https://track.ua-gis.com/gtfs/lviv/vehicle_position";
const STATIC_FEED_URL = "https://track.ua-gis.com/gtfs/lviv/static.zip";
const STATIC_CRON = "0 2 * * *";
const STATIC_LATEST_KEY = "static/_latest.json";
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 200;
const POLL_INTERVAL_MS = 10_000;
const POLLS_PER_CRON = 6;
const STALE_FEED_THRESHOLD_SECS = 300;
const PUT_MAX_RETRIES = 3;
const LIST_MAX_RETRIES = 3;

export default {
  // Cron trigger fires every minute; Cloudflare Cron Triggers can't fire
  // faster than 1/min, so we poll every 10s (in six 10s steps per 1-minute
  // cron fire) internally. Measured feed dynamics: median gap between a
  // vehicle's distinct GTFS-RT timestamps is ~10s (p90=30s), so 10s polling
  // captures most position updates that 30s/60s polling was discarding.
  //
  // A second, once-daily cron (STATIC_CRON) archives the GTFS static feed
  // instead — see collectStatic().
  async scheduled(event, env, ctx) {
    if (event.cron === STATIC_CRON) {
      ctx.waitUntil(collectStatic(env));
      return;
    }
    ctx.waitUntil(
      (async () => {
        // Shared across the six polls in this cron fire: dedupes
        // back-to-back identical snapshots and throttles Sentry noise to
        // at most one warning of each kind per fire.
        const state = { lastFeedTimestamp: null, warnedUnavailable: false, warnedStale: false };
        for (let i = 0; i < POLLS_PER_CRON; i++) {
          const start = Date.now();
          await collect(env, state);
          if (i < POLLS_PER_CRON - 1) {
            const elapsed = Date.now() - start;
            await new Promise((r) => setTimeout(r, Math.max(0, POLL_INTERVAL_MS - elapsed)));
          }
        }
      })(),
    );
  },

  // Manual trigger (for testing): curl https://your-worker.workers.dev/
  async fetch(request, env) {
    try {
      return await handleFetch(request, env);
    } catch (err) {
      // R2 binding errors carry no usable JS stack, so the path tag is the
      // only way to tell which endpoint failed once it reaches Sentry.
      let path = "unknown";
      try {
        path = new URL(request.url).pathname;
      } catch {
        // malformed URL; keep the placeholder
      }
      await captureToSentry(env, err, { tags: { handler: "fetch", path } });
      return new Response("error", { status: 500 });
    }
  },
};

async function handleFetch(request, env) {
  const url = new URL(request.url);

  if (url.pathname === "/health") {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const latest = await findLatestObject(env, today, now);
    const ageSecs = latest ? Math.round((now - latest.uploaded) / 1000) : null;

    const hour = kyivHour(now);
    const offHours = hour >= 0 && hour < 4;
    const healthy = offHours || (ageSecs !== null && ageSecs <= 180);

    return Response.json(
      { status: healthy ? "ok" : "stale", last_upload: latest?.uploaded ?? null, age_seconds: ageSecs, off_hours: offHours },
      { status: healthy ? 200 : 503 },
    );
  }

  if (url.pathname === "/latest") {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const latest = await findLatestObject(env, today, now);
    if (!latest) return Response.json({ error: "no snapshots found for today" }, { status: 404 });

    if (url.searchParams.has("raw")) {
      const obj = await env.BUCKET.get(latest.key);
      if (!obj) return new Response("not found", { status: 404 });
      return new Response(obj.body, {
        headers: { "Content-Type": obj.httpMetadata?.contentType || "application/x-protobuf" },
      });
    }

    const head = await env.BUCKET.head(latest.key);
    return Response.json({
      key: latest.key,
      size: head?.size ?? latest.size,
      uploaded: head?.uploaded ?? latest.uploaded,
      age_seconds: Math.round((now - latest.uploaded) / 1000),
      ...(head?.customMetadata ?? {}),
    });
  }

  if (url.pathname === "/stats") {
    return Response.json(await computeStats(env, url.searchParams.get("date")));
  }

  if (url.pathname === "/static") {
    await collectStatic(env);
    return new Response("ok");
  }

  if (url.pathname === "/static/latest") {
    const obj = await env.BUCKET.get(STATIC_LATEST_KEY);
    if (!obj) return Response.json({ error: "no static snapshot recorded yet" }, { status: 404 });
    return new Response(obj.body, { headers: { "Content-Type": "application/json" } });
  }

  if (url.pathname === "/list") {
    const date = url.searchParams.get("date");
    const limitParam = parseInt(url.searchParams.get("limit") || "20", 10);
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 1000) : 20;
    const cursor = url.searchParams.get("cursor") || undefined;
    const prefix = date ? `raw/${date}/` : undefined;

    const list = await listWithRetry(env.BUCKET, { prefix, limit, cursor });
    return Response.json({
      count: list.objects.length,
      keys: list.objects.map((o) => ({
        key: o.key,
        size: o.size,
        uploaded: o.uploaded,
      })),
      cursor: list.truncated ? list.cursor : null,
    });
  }

  await collect(env, {});
  return new Response("ok");
}

function kyivHour(date) {
  return parseInt(
    date.toLocaleString("en-US", { timeZone: "Europe/Kyiv", hour: "numeric", hour12: false }),
    10,
  );
}

// Finds the most recently uploaded object for a given day without paging
// through the whole day's keys. Objects are named with ISO timestamps, so
// they sort lexicographically in upload order; widening `startAfter`
// windows lets us find the latest object cheaply even if the feed has
// been down for a while (up to 4 hours).
async function findLatestObject(env, date, now) {
  for (const windowMin of [10, 60, 240]) {
    const startAfter = new Date(now - windowMin * 60 * 1000).toISOString();
    const list = await listWithRetry(env.BUCKET, {
      prefix: `raw/${date}/`,
      startAfter: `raw/${date}/${startAfter}`,
      // At 10s cadence, up to 6x the window (in minutes) objects can land
      // here; limit must clear that so .at(-1) is the true latest, not
      // just the last of a truncated page.
      limit: 1000,
    });
    if (list.objects.length > 0) return list.objects.at(-1);
  }
  const list = await listWithRetry(env.BUCKET, { prefix: `raw/${date}/`, limit: 1000 });
  return list.objects.at(-1) ?? null;
}

// Bounded to avoid unbounded R2 list cost on a day with tens of thousands
// of objects; a partial result is flagged via `partial` rather than eating
// unlimited subrequests.
const STATS_MAX_PAGES = 10;

async function computeStats(env, date) {
  const day = date || new Date().toISOString().slice(0, 10);
  const prefix = `raw/${day}/`;

  let cursor;
  let count = 0;
  let totalBytes = 0;
  let maxGapSecs = 0;
  let prevTs = null;
  let partial = false;

  for (let page = 0; page < STATS_MAX_PAGES; page++) {
    const list = await listWithRetry(env.BUCKET, { prefix, cursor, limit: 1000 });
    for (const obj of list.objects) {
      count++;
      totalBytes += obj.size;
      const ts = keyToTimestamp(obj.key);
      if (ts !== null) {
        if (prevTs !== null) maxGapSecs = Math.max(maxGapSecs, (ts - prevTs) / 1000);
        prevTs = ts;
      }
    }
    if (!list.truncated) break;
    cursor = list.cursor;
    partial = page === STATS_MAX_PAGES - 1;
  }

  return {
    date: day,
    count,
    total_bytes: totalBytes,
    avg_bytes: count > 0 ? Math.round(totalBytes / count) : 0,
    max_gap_seconds: Math.round(maxGapSecs),
    partial,
  };
}

function keyToTimestamp(key) {
  const match = key.match(/\/([\d-]+T[\d:.]+Z)\.pb$/);
  return match ? Date.parse(match[1]) : null;
}

function isValidGtfsFeed(buf) {
  // GTFS-RT FeedMessage always starts with field 1 (header), wire type 2 → 0x0A
  return buf.byteLength > 0 && new Uint8Array(buf)[0] === 0x0a;
}

// Returns { buf, failure }: `buf` is null when every attempt failed, and
// `failure` then classifies the last attempt (`http_404` vs `http_503` vs
// `network_error` vs `invalid_body`) so a permanent feed URL change is
// distinguishable from a transient upstream blip in Sentry.
async function fetchFeed() {
  let failure = "unknown";
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, BASE_DELAY_MS * 2 ** attempt));
    }
    try {
      const res = await fetch(FEED_URL);
      if (!res.ok) {
        failure = `http_${res.status}`;
        continue;
      }
      const buf = await res.arrayBuffer();
      if (isValidGtfsFeed(buf)) return { buf, failure: null };
      failure = "invalid_body";
    } catch {
      // network error, timeout, or body read failure
      failure = "network_error";
    }
  }
  return { buf: null, failure };
}

// R2 occasionally returns a transient internal error ("We encountered an
// internal error. Please try again. (10001)"); a couple of retries turn a
// lost snapshot into a slightly delayed one.
async function putWithRetry(bucket, key, buf, options) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await bucket.put(key, buf, options);
    } catch (err) {
      if (attempt === PUT_MAX_RETRIES - 1) throw err;
      await new Promise((r) => setTimeout(r, BASE_DELAY_MS * 2 ** attempt));
    }
  }
}

// R2 rejects list calls that pile up on the same prefix ("Reduce your
// concurrent request rate for the same object. (10058)") — this happens
// when a health/stats request lands while a collect cron fire is already
// touching the same day's prefix. Retrying turns a 500 into a slow 200.
async function listWithRetry(bucket, options) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await bucket.list(options);
    } catch (err) {
      if (attempt === LIST_MAX_RETRIES - 1) throw err;
      await new Promise((r) => setTimeout(r, BASE_DELAY_MS * 2 ** attempt));
    }
  }
}

async function collect(env, state) {
  try {
    const hour = kyivHour(new Date());
    if (hour >= 0 && hour < 4) return;

    const { buf, failure } = await fetchFeed();
    if (!buf) {
      if (!state.warnedUnavailable) {
        state.warnedUnavailable = true;
        await captureToSentry(env, "GTFS feed unavailable after all retries", {
          level: "warning",
          tags: { stage: "fetch_feed", feed_failure: failure },
        });
      }
      return;
    }

    let feedInfo = { headerTimestamp: null, entityCount: 0 };
    try {
      feedInfo = parseFeedInfo(buf);
    } catch {
      // unexpected/malformed structure; still write the raw snapshot, just
      // without the derived metadata, dedup, and staleness signal below
    }

    if (feedInfo.headerTimestamp !== null) {
      const ageSecs = Date.now() / 1000 - feedInfo.headerTimestamp;
      if (ageSecs > STALE_FEED_THRESHOLD_SECS && !state.warnedStale) {
        state.warnedStale = true;
        await captureToSentry(env, `GTFS feed is stale (${Math.round(ageSecs)}s old)`, {
          level: "warning",
          tags: { stage: "stale_feed" },
        });
      }

      if (feedInfo.headerTimestamp === state.lastFeedTimestamp) {
        // identical snapshot to the previous poll this cron fire; skip the write
        return;
      }
      state.lastFeedTimestamp = feedInfo.headerTimestamp;
    }

    const now = new Date();
    const key = `raw/${now.toISOString().slice(0, 10)}/${now.toISOString()}.pb`;

    // Optional: only written when the Analytics Engine binding is
    // configured (see wrangler.toml). Safe to leave unbound.
    if (env.ANALYTICS) {
      env.ANALYTICS.writeDataPoint({
        blobs: [key],
        doubles: [buf.byteLength, feedInfo.entityCount],
        indexes: ["gtfs-collector"],
      });
    }

    await putWithRetry(env.BUCKET, key, buf, {
      httpMetadata: { contentType: "application/x-protobuf" },
      customMetadata: {
        entityCount: String(feedInfo.entityCount),
        feedTimestamp: feedInfo.headerTimestamp !== null ? String(feedInfo.headerTimestamp) : "",
        bytes: String(buf.byteLength),
      },
    });
  } catch (err) {
    await captureToSentry(env, err, { tags: { stage: "collect" } });
  }
}

// Archives the GTFS static feed (schedule data: routes, trips, stop_times,
// calendar) once a day, dated by the day it was fetched. Unlike the
// realtime feed, static rarely changes — a HEAD request's ETag/Last-Modified
// is compared against the last archived copy (tracked in STATIC_LATEST_KEY)
// so an unchanged feed costs one small request and no R2 write, not a
// redundant multi-MB copy every day.
//
// Motivation: gtfs-eta (a downstream consumer) always scores/trains against
// *current* static, even for past days — if the schedule changes, historical
// scoring silently uses the wrong era. Dated snapshots here let it pin each
// day to the static that was actually in effect.
async function collectStatic(env) {
  try {
    const head = await fetch(STATIC_FEED_URL, { method: "HEAD" });
    if (!head.ok) {
      await captureToSentry(env, `GTFS static feed HEAD failed (http_${head.status})`, {
        level: "warning",
        tags: { stage: "fetch_static" },
      });
      return;
    }
    const etag = head.headers.get("etag") || "";
    const lastModified = head.headers.get("last-modified") || "";

    const prevObj = await env.BUCKET.get(STATIC_LATEST_KEY);
    const prev = prevObj ? await prevObj.json() : null;
    if (prev && etag && prev.etag === etag && prev.lastModified === lastModified) {
      return; // unchanged since the last archived copy
    }

    const res = await fetch(STATIC_FEED_URL);
    if (!res.ok) {
      await captureToSentry(env, `GTFS static feed GET failed (http_${res.status})`, {
        level: "warning",
        tags: { stage: "fetch_static" },
      });
      return;
    }
    const buf = await res.arrayBuffer();

    const day = new Date().toISOString().slice(0, 10);
    const key = `static/${day}/static.zip`;
    const meta = { etag, lastModified, bytes: String(buf.byteLength) };

    await putWithRetry(env.BUCKET, key, buf, {
      httpMetadata: { contentType: "application/zip" },
      customMetadata: meta,
    });
    await env.BUCKET.put(STATIC_LATEST_KEY, JSON.stringify({ ...meta, key, date: day }), {
      httpMetadata: { contentType: "application/json" },
    });
  } catch (err) {
    await captureToSentry(env, err, { tags: { stage: "collect_static" } });
  }
}

// --- Minimal dependency-free protobuf field walker ---
// We only need two things out of the GTFS-RT FeedMessage: the header
// timestamp (for dedup + staleness detection) and a count of top-level
// entities (for metadata). A full protobuf runtime is overkill for that,
// so this walks tags and skips values by wire type instead.

function readVarint(view, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    const byte = view.getUint8(pos);
    result += (byte & 0x7f) * 2 ** shift;
    pos++;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [result, pos - offset];
}

function skipField(view, offset, wireType) {
  switch (wireType) {
    case 0: {
      // varint
      const [, len] = readVarint(view, offset);
      return offset + len;
    }
    case 1:
      // 64-bit fixed
      return offset + 8;
    case 2: {
      // length-delimited
      const [len, lenBytes] = readVarint(view, offset);
      return offset + lenBytes + len;
    }
    case 5:
      // 32-bit fixed
      return offset + 4;
    default:
      throw new Error(`unsupported protobuf wire type ${wireType}`);
  }
}

function parseFeedInfo(buf) {
  const view = new DataView(buf);
  const size = buf.byteLength;
  let offset = 0;
  let headerTimestamp = null;
  let entityCount = 0;

  while (offset < size) {
    const [tag, tagLen] = readVarint(view, offset);
    offset += tagLen;
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x7;

    if (fieldNumber === 1 && wireType === 2) {
      // FeedHeader submessage
      const [len, lenBytes] = readVarint(view, offset);
      offset += lenBytes;
      headerTimestamp = parseHeaderTimestamp(view, offset, offset + len);
      offset += len;
    } else if (fieldNumber === 2 && wireType === 2) {
      // FeedEntity — only counted, not decoded
      entityCount++;
      offset = skipField(view, offset, wireType);
    } else {
      offset = skipField(view, offset, wireType);
    }
  }

  return { headerTimestamp, entityCount };
}

function parseHeaderTimestamp(view, start, end) {
  let offset = start;
  while (offset < end) {
    const [tag, tagLen] = readVarint(view, offset);
    offset += tagLen;
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x7;
    if (fieldNumber === 3 && wireType === 0) {
      const [value] = readVarint(view, offset);
      return value; // uint64 seconds since epoch; safe as Number for realistic dates
    }
    offset = skipField(view, offset, wireType);
  }
  return null;
}

// Minimal dependency-free Sentry client. Builds a single-event envelope and
// POSTs it to the project's ingest endpoint derived from the DSN. Every event
// carries `service: "gtfs-collector"` so it can be filtered out of the shared
// Sentry project. Reporting failures are swallowed — they must never break
// collection.
async function captureToSentry(env, errorOrMessage, context = {}) {
  if (!env.SENTRY_DSN) return;
  try {
    const dsn = new URL(env.SENTRY_DSN);
    const projectId = dsn.pathname.slice(1);
    const endpoint = `${dsn.protocol}//${dsn.host}/api/${projectId}/envelope/`;
    const eventId = crypto.randomUUID().replace(/-/g, "");

    const event = {
      event_id: eventId,
      timestamp: Date.now() / 1000,
      platform: "javascript",
      level: context.level || "error",
      server_name: "gtfs-collector",
      environment: env.SENTRY_ENVIRONMENT || "production",
      tags: { service: "gtfs-collector", ...context.tags },
    };

    if (errorOrMessage instanceof Error) {
      event.exception = {
        values: [
          {
            type: errorOrMessage.name,
            value: errorOrMessage.message,
            stacktrace: { frames: parseStackFrames(errorOrMessage.stack) },
          },
        ],
      };
    } else {
      event.message = String(errorOrMessage);
    }

    const envelope =
      JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString(), dsn: env.SENTRY_DSN }) +
      "\n" +
      JSON.stringify({ type: "event" }) +
      "\n" +
      JSON.stringify(event);

    await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope" },
      body: envelope,
    });
  } catch {
    // never let error reporting break the worker
  }
}

// Parse a V8 stack trace into Sentry frames (oldest call first).
function parseStackFrames(stack) {
  if (!stack) return [];
  return stack
    .split("\n")
    .slice(1)
    .map((line) => {
      const m = line.match(/at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/);
      return m ? { function: m[1] || "?", filename: m[2], lineno: +m[3], colno: +m[4] } : null;
    })
    .filter(Boolean)
    .reverse();
}

// Exposed for unit tests only; Cloudflare's Worker runtime only invokes the
// default export's `scheduled`/`fetch` handlers.
export const __testing = {
  isValidGtfsFeed,
  parseFeedInfo,
  readVarint,
  skipField,
  keyToTimestamp,
  kyivHour,
  computeStats,
  findLatestObject,
  collect,
  fetchFeed,
  putWithRetry,
  listWithRetry,
  collectStatic,
};
