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
  // vitest-plugin gives each test an isolated storage snapshot per
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
      feedTimestamp: "1700000000",
      bytes: String(head.size),
    });
  });
});

describe("routing and auth", () => {
  it("returns 404 for favicon.ico and robots.txt without collecting", async () => {
    const fetchMock = vi.fn(async () => new Response(buildFeedMessage({ timestamp: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    for (const path of ["/favicon.ico", "/robots.txt"]) {
      const res = await run(new Request(`https://example.com${path}`));
      expect(res.status).toBe(404);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await listAll()).toHaveLength(0);
  });

  it("still collects on any other unknown path (backward compatible)", async () => {
    mockFeedOnce(buildFeedMessage({ timestamp: 1_700_000_000 }));
    const res = await run(new Request("https://example.com/collect"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(await listAll()).toHaveLength(1);
  });

  it("answers a malformed ?date with an empty result, not an error", async () => {
    const res = await run(new Request("https://example.com/stats?date=2026-07"));
    expect(res.status).toBe(200);
    expect((await res.json()).count).toBe(0);

    const list = await run(new Request("https://example.com/list?date=nope"));
    expect(list.status).toBe(200);
    expect((await list.json()).count).toBe(0);
  });

  it("requires ADMIN_TOKEN for write endpoints when configured", async () => {
    mockFeedOnce(buildFeedMessage({ timestamp: 1_700_000_000 }));
    const authedEnv = { ...env, ADMIN_TOKEN: "s3cret" };
    const call = async (req) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, authedEnv, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };

    expect((await call(new Request("https://example.com/"))).status).toBe(401);
    expect((await call(new Request("https://example.com/static"))).status).toBe(401);
    expect((await call(new Request("https://example.com/collect"))).status).toBe(401);
    expect(await listAll()).toHaveLength(0);

    const ok = await call(new Request("https://example.com/", { headers: { Authorization: "Bearer s3cret" } }));
    expect(ok.status).toBe(200);
    expect(await listAll()).toHaveLength(1);

    // read-only endpoints stay open
    expect((await call(new Request("https://example.com/stats"))).status).toBe(200);
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
    // 04:00Z is 07:00 Kyiv in summer (UTC+3)
    expect(body.by_hour_kyiv["07:00"]).toBe(3);
    // chronological key order in the serialized JSON
    expect(Object.keys(body.by_hour_kyiv)).toEqual(Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`));
    expect(Object.values(body.by_hour_kyiv).reduce((a, b) => a + b, 0)).toBe(3);
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

describe("GET /health feed staleness", () => {
  const now = new Date("2026-07-08T07:00:00Z");
  const putSnapshot = (feedTimestamp) =>
    env.BUCKET.put(`raw/2026-07-08/${now.toISOString()}.pb`, new Uint8Array(1), {
      customMetadata: { feedTimestamp, bytes: "1" },
    });

  it("is ok when the latest snapshot carries a fresh feed timestamp", async () => {
    vi.setSystemTime(new Date(now.getTime() + 5_000));
    await putSnapshot(String(now.getTime() / 1000 - 30));

    const res = await run(new Request("https://example.com/health"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.feed_age_seconds).toBe(35);
  });

  it("reports feed_stale when uploads are fresh but the feed timestamp is old", async () => {
    vi.setSystemTime(new Date(now.getTime() + 5_000));
    await putSnapshot(String(now.getTime() / 1000 - 600));

    const res = await run(new Request("https://example.com/health"));
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.status).toBe("feed_stale");
    expect(body.feed_age_seconds).toBe(605);
  });

  it("ignores a snapshot with no feed timestamp", async () => {
    vi.setSystemTime(new Date(now.getTime() + 5_000));
    await putSnapshot("");

    const res = await run(new Request("https://example.com/health"));
    const body = await res.json();
    expect(body.feed_age_seconds).toBe(null);
    expect(body.status).not.toBe("feed_stale");
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

describe("collect() write failures", () => {
  it("does not treat a feed whose write failed as already stored", async () => {
    vi.useRealTimers(); // putWithRetry backs off with real (short) delays
    const state = { lastFeedTimestamp: null, warnedUnavailable: false, warnedStale: false };
    mockFeedOnce(buildFeedMessage({ timestamp: 1_700_000_040 }));
    const failingEnv = { ...env, BUCKET: { put: vi.fn(async () => { throw new Error("boom"); }) } };

    await __testing.collect(failingEnv, state);
    expect(state.lastFeedTimestamp).toBe(null);

    await __testing.collect(env, state);
    expect(await listAll()).toHaveLength(1);
  });
});

describe("scheduled() dedup across cron fires", () => {
  async function fire() {
    const ctx = createExecutionContext();
    await worker.scheduled({ cron: "* 1-21 * * *" }, env, ctx);
    await vi.advanceTimersByTimeAsync(60_000);
    await waitOnExecutionContext(ctx);
  }

  it("skips the first poll of a fire when the feed hasn't changed since the previous fire", async () => {
    __testing.resetDedup();
    mockFeedOnce(buildFeedMessage({ timestamp: 1_700_000_050 }));

    await fire();
    expect(await listAll()).toHaveLength(1);

    await fire();
    expect(await listAll()).toHaveLength(1);

    mockFeedOnce(buildFeedMessage({ timestamp: 1_700_000_060 }));
    await fire();
    expect(await listAll()).toHaveLength(2);
  });
});

describe("fetchFeed() failure classification", () => {
  async function fetchFeedWithTimers() {
    // fetchFeed backs off between attempts; drive those timers instead of
    // waiting out the real ~6s of delays.
    const promise = __testing.fetchFeed();
    await vi.advanceTimersByTimeAsync(30_000);
    return promise;
  }

  it("reports the HTTP status of the last failed attempt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("gone", { status: 404 })),
    );

    const result = await fetchFeedWithTimers();
    expect(result.buf).toBeNull();
    expect(result.failure).toBe("http_404");
  });

  it("distinguishes a network error from an HTTP error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection reset");
      }),
    );

    expect((await fetchFeedWithTimers()).failure).toBe("network_error");
  });

  it("flags a 200 response that is not a GTFS-RT FeedMessage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([0xff, 0xff]), { status: 200 })),
    );

    expect((await fetchFeedWithTimers()).failure).toBe("invalid_body");
  });

  it("returns the buffer with no failure on success", async () => {
    mockFeedOnce(buildFeedMessage({ timestamp: 1_700_000_040, entityCount: 1 }));

    const result = await fetchFeedWithTimers();
    expect(result.failure).toBeNull();
    expect(result.buf.byteLength).toBeGreaterThan(0);
  });
});

describe("putWithRetry()", () => {
  async function putWithTimers(bucket) {
    // Settle-capture before advancing timers: the rejection lands while the
    // fake clock is being driven, and would otherwise surface as an
    // unhandled rejection before the assertion attaches.
    const settled = __testing
      .putWithRetry(bucket, "raw/x.pb", new Uint8Array([1]), {})
      .then((value) => ({ value }), (error) => ({ error }));
    await vi.advanceTimersByTimeAsync(30_000);
    const outcome = await settled;
    if (outcome.error) throw outcome.error;
    return outcome.value;
  }

  it("retries a transient R2 internal error and succeeds", async () => {
    let calls = 0;
    const bucket = {
      put: vi.fn(async () => {
        calls++;
        if (calls < 3) throw new Error("put: We encountered an internal error. Please try again. (10001)");
        return { key: "raw/x.pb" };
      }),
    };

    await expect(putWithTimers(bucket)).resolves.toEqual({ key: "raw/x.pb" });
    expect(bucket.put).toHaveBeenCalledTimes(3);
  });

  it("rethrows after the retry budget is exhausted", async () => {
    const bucket = {
      put: vi.fn(async () => {
        throw new Error("put: We encountered an internal error. Please try again. (10001)");
      }),
    };

    await expect(putWithTimers(bucket)).rejects.toThrow("10001");
    expect(bucket.put).toHaveBeenCalledTimes(3);
  });
});

describe("listWithRetry()", () => {
  const RATE_LIMIT = "list: Reduce your concurrent request rate for the same object. (10058)";

  async function listWithTimers(bucket) {
    // Same settle-capture dance as putWithTimers above.
    const settled = __testing
      .listWithRetry(bucket, { prefix: "raw/2026-07-08/" })
      .then((value) => ({ value }), (error) => ({ error }));
    await vi.advanceTimersByTimeAsync(30_000);
    const outcome = await settled;
    if (outcome.error) throw outcome.error;
    return outcome.value;
  }

  it("retries an R2 concurrent-request rate limit and succeeds", async () => {
    let calls = 0;
    const bucket = {
      list: vi.fn(async () => {
        calls++;
        if (calls < 3) throw new Error(RATE_LIMIT);
        return { objects: [], truncated: false };
      }),
    };

    await expect(listWithTimers(bucket)).resolves.toEqual({ objects: [], truncated: false });
    expect(bucket.list).toHaveBeenCalledTimes(3);
  });

  it("rethrows after the retry budget is exhausted", async () => {
    const bucket = {
      list: vi.fn(async () => {
        throw new Error(RATE_LIMIT);
      }),
    };

    await expect(listWithTimers(bucket)).rejects.toThrow("10058");
    expect(bucket.list).toHaveBeenCalledTimes(3);
  });
});
