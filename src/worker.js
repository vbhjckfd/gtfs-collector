const FEED_URL = "https://track.ua-gis.com/gtfs/lviv/vehicle_position";
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 0.2;

export default {
  // Cron trigger
  async scheduled(event, env, ctx) {
    ctx.waitUntil(collect(env));
  },

  // Manual trigger (for testing): curl https://your-worker.workers.dev/
  async fetch(request, env) {
    try {
      return await handleFetch(request, env);
    } catch (err) {
      await captureToSentry(env, err, { tags: { handler: "fetch" } });
      return new Response("error", { status: 500 });
    }
  },
};

async function handleFetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      const tenMinAgo = new Date(now - 10 * 60 * 1000).toISOString();

      const list = await env.BUCKET.list({
        prefix: `raw/${today}/`,
        startAfter: `raw/${today}/${tenMinAgo}`,
        limit: 20,
      });

      // objects are in lexicographic key order; ISO timestamps sort correctly
      const latest = list.objects.at(-1);
      const ageSecs = latest ? Math.round((now - latest.uploaded) / 1000) : null;

      const hour = parseInt(
        now.toLocaleString("en-US", { timeZone: "Europe/Kyiv", hour: "numeric", hour12: false }),
        10,
      );
      const offHours = hour >= 0 && hour < 4;
      const healthy = offHours || (ageSecs !== null && ageSecs <= 180);

      return Response.json(
        { status: healthy ? "ok" : "stale", last_upload: latest?.uploaded ?? null, age_seconds: ageSecs, off_hours: offHours },
        { status: healthy ? 200 : 503 },
      );
    }

    if (url.pathname === "/list") {
      const list = await env.BUCKET.list({ limit: 20 });
      return Response.json({
        count: list.objects.length,
        keys: list.objects.map((o) => ({
          key: o.key,
          size: o.size,
          uploaded: o.uploaded,
        })),
      });
    }

    await collect(env);
    return new Response("ok");
}

function isValidGtfsFeed(buf) {
  // GTFS-RT FeedMessage always starts with field 1 (header), wire type 2 → 0x0A
  return buf.byteLength > 0 && new Uint8Array(buf)[0] === 0x0a;
}

async function fetchFeed() {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, BASE_DELAY_MS * 2 ** attempt));
    }
    try {
      const res = await fetch(FEED_URL);
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      if (isValidGtfsFeed(buf)) return buf;
    } catch {
      // network error, timeout, or body read failure
    }
  }
  return null;
}

async function collect(env) {
  try {
    const hour = parseInt(
      new Date().toLocaleString("en-US", {
        timeZone: "Europe/Kyiv",
        hour: "numeric",
        hour12: false,
      }),
      10,
    );
    if (hour >= 0 && hour < 4) return;

    const buf = await fetchFeed();
    if (!buf) {
      await captureToSentry(env, "GTFS feed unavailable after all retries", {
        level: "warning",
        tags: { stage: "fetch_feed" },
      });
      return;
    }

    const now = new Date();
    const key = `raw/${now.toISOString().slice(0, 10)}/${now.toISOString()}.pb`;

    await env.BUCKET.put(key, buf, {
      httpMetadata: { contentType: "application/x-protobuf" },
    });
  } catch (err) {
    await captureToSentry(env, err, { tags: { stage: "collect" } });
  }
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
