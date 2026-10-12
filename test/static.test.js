import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { __testing } from "../src/worker.js";

function mockStaticFeed({
  etag = '"abc123"',
  lastModified = "Thu, 02 Jul 2026 10:22:36 GMT",
  body = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]),
  status = 200,
} = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, opts) => {
      const headers = new Headers();
      if (etag !== null) headers.set("etag", etag);
      if (lastModified !== null) headers.set("last-modified", lastModified);
      if (opts?.method === "HEAD") {
        return new Response(null, { status, headers });
      }
      return new Response(body, { status, headers });
    }),
  );
}

async function run(request) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function listAll(prefix) {
  const list = await env.BUCKET.list(prefix ? { prefix } : undefined);
  return list.objects;
}

beforeEach(async () => {
  const objects = await listAll();
  await Promise.all(objects.map((o) => env.BUCKET.delete(o.key)));

  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-31T02:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("collectStatic()", () => {
  it("archives the feed on first run", async () => {
    mockStaticFeed();
    await __testing.collectStatic(env);

    const dated = await listAll("static/2026-07-31/");
    expect(dated).toHaveLength(1);
    expect(dated[0].key).toBe("static/2026-07-31/static.zip");

    const head = await env.BUCKET.head(dated[0].key);
    expect(head.customMetadata).toEqual({
      etag: '"abc123"',
      lastModified: "Thu, 02 Jul 2026 10:22:36 GMT",
      bytes: "8",
    });

    const marker = await env.BUCKET.get("static/_latest.json");
    expect(JSON.parse(await marker.text())).toMatchObject({
      etag: '"abc123"',
      key: "static/2026-07-31/static.zip",
      date: "2026-07-31",
    });
    expect(JSON.parse(await (await env.BUCKET.get("static/_latest.json")).text()).sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("skips the write when the feed is unchanged (same etag/last-modified)", async () => {
    mockStaticFeed();
    await __testing.collectStatic(env);

    vi.setSystemTime(new Date("2026-08-01T02:00:00.000Z"));
    mockStaticFeed();
    await __testing.collectStatic(env);

    const dated = await listAll("static/");
    // Only the original dated copy + the marker — nothing for 2026-08-01.
    expect(dated.filter((o) => o.key.endsWith("static.zip"))).toHaveLength(1);
  });

  it("archives a new dated copy when the feed actually changed", async () => {
    mockStaticFeed({ etag: '"abc123"' });
    await __testing.collectStatic(env);

    vi.setSystemTime(new Date("2026-08-01T02:00:00.000Z"));
    mockStaticFeed({
      etag: '"def456"',
      lastModified: "Fri, 31 Jul 2026 09:00:00 GMT",
      body: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 9]),
    });
    await __testing.collectStatic(env);

    const dated = await listAll("static/");
    expect(dated.filter((o) => o.key.endsWith("static.zip")).map((o) => o.key).sort()).toEqual([
      "static/2026-07-31/static.zip",
      "static/2026-08-01/static.zip",
    ]);

    const marker = await env.BUCKET.get("static/_latest.json");
    expect(JSON.parse(await marker.text())).toMatchObject({ etag: '"def456"' });
  });

  it("does not write anything when the HEAD request fails", async () => {
    mockStaticFeed({ status: 500 });
    await __testing.collectStatic(env);

    expect(await listAll("static/")).toHaveLength(0);
  });

  it("does not write anything when the GET request fails after a changed HEAD", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, opts) => {
        if (opts?.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { etag: '"xyz"', "last-modified": "Fri, 31 Jul 2026 09:00:00 GMT" },
          });
        }
        return new Response("nope", { status: 503 });
      }),
    );

    await __testing.collectStatic(env);
    expect(await listAll("static/")).toHaveLength(0);
  });
});

describe("collectStatic() without usable validators", () => {
  it("does not re-archive identical content when the server sends no ETag/Last-Modified", async () => {
    mockStaticFeed({ etag: null, lastModified: null });
    await __testing.collectStatic(env);

    vi.setSystemTime(new Date("2026-08-01T02:00:00.000Z"));
    mockStaticFeed({ etag: null, lastModified: null });
    await __testing.collectStatic(env);

    const zips = (await listAll("static/")).filter((o) => o.key.endsWith("static.zip"));
    expect(zips.map((o) => o.key)).toEqual(["static/2026-07-31/static.zip"]);
  });

  it("refreshes the marker but keeps one copy when validators change and content doesn't", async () => {
    mockStaticFeed({ etag: '"abc123"' });
    await __testing.collectStatic(env);

    vi.setSystemTime(new Date("2026-08-01T02:00:00.000Z"));
    mockStaticFeed({ etag: '"def456"' });
    await __testing.collectStatic(env);

    const zips = (await listAll("static/")).filter((o) => o.key.endsWith("static.zip"));
    expect(zips).toHaveLength(1);
    const marker = JSON.parse(await (await env.BUCKET.get("static/_latest.json")).text());
    expect(marker).toMatchObject({ etag: '"def456"', key: "static/2026-07-31/static.zip", date: "2026-07-31" });
  });

  it("still archives when HEAD is not supported", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, opts) =>
        opts?.method === "HEAD"
          ? new Response(null, { status: 405 })
          : new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), { status: 200 }),
      ),
    );
    await __testing.collectStatic(env);
    expect(await listAll("static/2026-07-31/")).toHaveLength(1);
  });

  it("refuses to archive a body that is not a zip", async () => {
    mockStaticFeed({ body: "<html>maintenance</html>" });
    await __testing.collectStatic(env);
    expect(await listAll("static/")).toHaveLength(0);
  });
});

describe("GET /static", () => {
  it("triggers an archive check and returns ok", async () => {
    mockStaticFeed();
    const res = await run(new Request("https://example.com/static"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    expect(await listAll("static/2026-07-31/")).toHaveLength(1);
  });
});

describe("GET /static/list", () => {
  it("lists archived static snapshots oldest first, without the marker", async () => {
    mockStaticFeed({ etag: '"abc123"' });
    await __testing.collectStatic(env);
    vi.setSystemTime(new Date("2026-08-01T02:00:00.000Z"));
    mockStaticFeed({ etag: '"def456"', body: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9]) });
    await __testing.collectStatic(env);

    const res = await run(new Request("https://example.com/static/list"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(2);
    expect(body.cursor).toBe(null);
    expect(body.snapshots.map((s) => [s.date, s.key, s.etag])).toEqual([
      ["2026-07-31", "static/2026-07-31/static.zip", '"abc123"'],
      ["2026-08-01", "static/2026-08-01/static.zip", '"def456"'],
    ]);
    expect(body.snapshots[0].size).toBe(8);
  });

  it("returns an empty list when nothing has been archived", async () => {
    const body = await (await run(new Request("https://example.com/static/list"))).json();
    expect(body).toEqual({ count: 0, snapshots: [], cursor: null });
  });

  it("does not trigger a collection", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await run(new Request("https://example.com/static/list"));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GET /static/latest", () => {
  it("returns 404 when nothing has been archived yet", async () => {
    const res = await run(new Request("https://example.com/static/latest"));
    expect(res.status).toBe(404);
  });

  it("returns the marker metadata after an archive run", async () => {
    mockStaticFeed();
    await __testing.collectStatic(env);

    const res = await run(new Request("https://example.com/static/latest"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ etag: '"abc123"', date: "2026-07-31" });
  });
});
