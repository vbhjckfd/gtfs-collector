const FEED_URL = "https://track.ua-gis.com/gtfs/lviv/vehicle_position";

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

  let res;
  try {
    res = await fetch(FEED_URL);
  } catch {
    return;
  }
  if (!res.ok) return;

  const buf = await res.arrayBuffer();
  const now = new Date();
  const key = `raw/${now.toISOString().slice(0, 10)}/${now.toISOString()}.pb`;

  await env.BUCKET.put(key, buf, {
    httpMetadata: { contentType: "application/x-protobuf" },
  });
}
