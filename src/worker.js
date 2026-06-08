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
    const url = new URL(request.url);

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
  },
};

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
  if (!buf) return;

  const now = new Date();
  const key = `raw/${now.toISOString().slice(0, 10)}/${now.toISOString()}.pb`;

  await env.BUCKET.put(key, buf, {
    httpMetadata: { contentType: "application/x-protobuf" },
  });
}
