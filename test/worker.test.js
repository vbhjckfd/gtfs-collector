import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { __testing } from "../src/worker.js";
import { buildFeedMessage } from "./protobuf-helpers.js";

function mockFeedOnce(buf) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(buf, { status: 200 })),
  );
}

async function run(request) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function listAll() {
  const list = await env.BUCKET.list();
  return list.objects;
}

beforeEach(async () => {
  // vitest-pool-workers gives each test an isolated storage snapshot per
  // file, but clear explicitly so test order within this file can't leak.
  const objects = await listAll();
  await Promise.all(objects.map((o) => env.BUCKET.delete(o.key)));

  // Default to a fixed instant inside the active collection window
  // (10:00 Kyiv) so tests don't depend on the real wall-clock time; tests
  // that care about a specific hour override this explicitly.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-08T07:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("GET / (manual trigger)", () => {
  it("fetches the feed and writes a snapshot to R2", async () => {
    mockFeedOnce(buildFeedMessage({ timestamp: 1_700_000_000, entityCount: 3 }));

    const res = await run(new Request("https://example.com/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    const objects = await listAll();
    expect(objects).toHaveLength(1);
    expect(objects[0].key).toMatch(/^raw\/\d{4}-\d{2}-\d{2}\/.*\.pb$/);

    const head = await env.BUCKET.head(objects[0].key);
    expect(head.customMetadata).toEqual({
      entityCount: "3",
      feedTimestamp: "1700000000",
      bytes: String(head.size),
    });
  });
});

describe("GET /list", () => {
  it("defaults to the 20 most recent objects with no filters", async () => {
    mockFeedOnce(buildFeedMessage({ timestamp: 1_700_000_001, entityCount: 1 }));
    await run(new Request("https://example.com/"));

    const res = await run(new Request("https://example.com/list"));
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.cursor).toBeNull();
  });

  it("filters by ?date and respects ?limit", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await env.BUCKET.put(`raw/${today}/a.pb`, new Uint8Array([1]));
    await env.BUCKET.put(`raw/${today}/b.pb`, new Uint8Array([2]));
    await env.BUCKET.put(`raw/2000-01-01/old.pb`, new Uint8Array([3]));

    const res = await run(new Request(`https://example.com/list?date=${today}&limit=1`));
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.keys[0].key).toMatch(new RegExp(`^raw/${today}/`));
  });
});

describe("GET /latest", () => {
  it("returns 404 when there are no snapshots today", async () => {
    const res = await run(new Request("https://example.com/latest"));
    expect(res.status).toBe(404);
  });

  it("returns metadata for the most recent snapshot", async () => {
    mockFeedOnce(buildFeedMessage({ timestamp: 1_700_000_002, entityCount: 7 }));
    await run(new Request("https://example.com/"));

    const res = await run(new Request("https://example.com/latest"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entityCount).toBe("7");
    expect(body.feedTimestamp).toBe("1700000002");
    expect(typeof body.age_seconds).toBe("number");
  });

  it("streams raw protobuf bytes with ?raw", async () => {
    const buf = buildFeedMessage({ timestamp: 1_700_000_003, entityCount: 2 });
    mockFeedOnce(buf);
    await run(new Request("https://example.com/"));

    const res = await run(new Request("https://example.com/latest?raw"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/x-protobuf");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes).toEqual(new Uint8Array(buf));
  });
});

describe("GET /stats", () => {
  it("summarizes count, bytes, and gaps for a day", async () => {
    const day = "2026-07-08";
    await env.BUCKET.put(`raw/${day}/${day}T04:00:00.000Z.pb`, new Uint8Array(10));
    await env.BUCKET.put(`raw/${day}/${day}T04:00:10.000Z.pb`, new Uint8Array(20));
    await env.BUCKET.put(`raw/${day}/${day}T04:00:40.000Z.pb`, new Uint8Array(30));

    const res = await run(new Request(`https://example.com/stats?date=${day}`));
    const body = await res.json();
    expect(body.count).toBe(3);
    expect(body.total_bytes).toBe(60);
    expect(body.avg_bytes).toBe(20);
    expect(body.max_gap_seconds).toBe(30);
    expect(body.partial).toBe(false);
  });

  it("defaults to today when no ?date is given", async () => {
    const res = await run(new Request("https://example.com/stats"));
    const body = await res.json();
    expect(body.date).toBe(new Date().toISOString().slice(0, 10));
    expect(body.count).toBe(0);
  });
});

describe("GET /health", () => {
  it("reports stale when there is no recent snapshot (outside off-hours)", async () => {
    // Fixed instant well inside the active collection window (10:00 Kyiv, no DST edge)
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-08T07:00:00Z"));

    const res = await run(new Request("https://example.com/health"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("stale");
    expect(body.off_hours).toBe(false);

    vi.useRealTimers();
  });

  it("reports healthy off-hours even with no snapshot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T23:00:00Z")); // 02:00 Kyiv (UTC+3 in summer), off-hours

    const res = await run(new Request("https://example.com/health"));
    const body = await res.json();
    expect(body.off_hours).toBe(true);
    expect(body.status).toBe("ok");
    expect(res.status).toBe(200);

    vi.useRealTimers();
  });
});

describe("collect() dedup and staleness", () => {
  it("skips writing a duplicate snapshot with an unchanged feed timestamp", async () => {
    const state = { lastFeedTimestamp: null, warnedUnavailable: false, warnedStale: false };
    mockFeedOnce(buildFeedMessage({ timestamp: 1_700_000_010, entityCount: 1 }));

    await __testing.collect(env, state);
    mockFeedOnce(buildFeedMessage({ timestamp: 1_700_000_010, entityCount: 1 }));
    await __testing.collect(env, state);

    const objects = await listAll();
    expect(objects).toHaveLength(1);
  });

  it("writes again once the feed timestamp changes", async () => {
    // Distinct wall-clock instants so the two writes get distinct R2 keys
    // (keys are timestamped to the millisecond).
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-08T07:00:00.000Z"));

    const state = { lastFeedTimestamp: null, warnedUnavailable: false, warnedStale: false };

    mockFeedOnce(buildFeedMessage({ timestamp: 1_700_000_020, entityCount: 1 }));
    await __testing.collect(env, state);

    vi.setSystemTime(new Date("2026-07-08T07:00:10.000Z"));
    mockFeedOnce(buildFeedMessage({ timestamp: 1_700_000_030, entityCount: 1 }));
    await __testing.collect(env, state);

    vi.useRealTimers();

    const objects = await listAll();
    expect(objects).toHaveLength(2);
  });
});
