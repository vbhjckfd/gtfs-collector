import { describe, expect, it } from "vitest";
import { __testing } from "../src/worker.js";
import { buildFeedMessage } from "./protobuf-helpers.js";

const { isValidGtfsFeed, parseFeedInfo, readVarint, keyToTimestamp, kyivHour, kyivUtcOffsetHours } = __testing;

describe("readVarint", () => {
  it("decodes single-byte varints", () => {
    const view = new DataView(Uint8Array.from([0x00]).buffer);
    expect(readVarint(view, 0)).toEqual([0, 1]);
  });

  it("decodes multi-byte varints", () => {
    // 300 = 0b100101100 -> bytes [0xAC, 0x02]
    const view = new DataView(Uint8Array.from([0xac, 0x02]).buffer);
    expect(readVarint(view, 0)).toEqual([300, 2]);
  });

  it("decodes large varints (unix timestamps)", () => {
    const timestamp = 1_780_000_000;
    const buf = buildFeedMessage({ timestamp });
    const info = parseFeedInfo(buf);
    expect(info.headerTimestamp).toBe(timestamp);
  });
});

describe("parseFeedInfo", () => {
  it("extracts the header timestamp", () => {
    const buf = buildFeedMessage({ timestamp: 1_700_000_000, entityCount: 5 });
    expect(parseFeedInfo(buf)).toEqual({ headerTimestamp: 1_700_000_000 });
  });

  it("returns null timestamp when the header has none", () => {
    const buf = buildFeedMessage({ entityCount: 2, timestamp: undefined });
    expect(parseFeedInfo(buf).headerTimestamp).toBeNull();
  });

  it("stops at the header without walking the entities", () => {
    // Garbage after the header (wire type 7 is invalid) would throw if the
    // parser kept going.
    const feed = new Uint8Array(buildFeedMessage({ timestamp: 1_700_000_000 }));
    const buf = new Uint8Array(feed.length + 1);
    buf.set(feed);
    buf[feed.length] = 0x0f;
    expect(parseFeedInfo(buf.buffer).headerTimestamp).toBe(1_700_000_000);
  });

  it("throws on truncated/malformed input rather than looping forever", () => {
    // a length-delimited tag whose declared length exceeds the buffer
    const buf = Uint8Array.from([0x0a, 0xff, 0xff, 0xff, 0xff, 0x0f]).buffer;
    expect(() => parseFeedInfo(buf)).toThrow();
  });
});

describe("isValidGtfsFeed", () => {
  it("accepts a buffer starting with the FeedMessage header tag", () => {
    const buf = buildFeedMessage({ timestamp: 1_700_000_000 });
    expect(isValidGtfsFeed(buf)).toBe(true);
  });

  it("rejects an empty buffer", () => {
    expect(isValidGtfsFeed(new ArrayBuffer(0))).toBe(false);
  });

  it("rejects a buffer with the wrong leading byte", () => {
    expect(isValidGtfsFeed(Uint8Array.from([0xff, 0x00]).buffer)).toBe(false);
  });
});

describe("keyToTimestamp", () => {
  it("parses the ISO timestamp out of a raw snapshot key", () => {
    const key = "raw/2026-07-08/2026-07-08T04:00:01.000Z.pb";
    expect(keyToTimestamp(key)).toBe(Date.parse("2026-07-08T04:00:01.000Z"));
  });

  it("returns null for a key with no parseable timestamp", () => {
    expect(keyToTimestamp("raw/2026-07-08/not-a-timestamp.pb")).toBeNull();
  });
});

describe("kyivHour", () => {
  it("returns an hour in the valid 0-23 range", () => {
    const hour = kyivHour(new Date());
    expect(hour).toBeGreaterThanOrEqual(0);
    expect(hour).toBeLessThanOrEqual(23);
  });

  it("converts a known UTC instant to the correct Kyiv hour", () => {
    // 2026-07-08T10:00:00Z is summer (UTC+3 under DST) -> 13:00 Kyiv
    expect(kyivHour(new Date("2026-07-08T10:00:00Z"))).toBe(13);
  });
});

describe("kyivUtcOffsetHours", () => {
  it("is +3 in summer and +2 in winter", () => {
    expect(kyivUtcOffsetHours(new Date("2026-07-08T12:00:00Z"))).toBe(3);
    expect(kyivUtcOffsetHours(new Date("2026-01-15T12:00:00Z"))).toBe(2);
  });

  it("uses the post-switch offset on DST change days", () => {
    expect(kyivUtcOffsetHours(new Date("2026-03-29T12:00:00Z"))).toBe(3);
    expect(kyivUtcOffsetHours(new Date("2026-10-25T12:00:00Z"))).toBe(2);
  });

  it("matches the IANA Europe/Kyiv zone hour by hour across 2024-2030", () => {
    const intlHour = (d) =>
      parseInt(d.toLocaleString("en-US", { timeZone: "Europe/Kyiv", hour: "numeric", hourCycle: "h23" }), 10);
    const mismatches = [];
    for (let t = Date.UTC(2024, 0, 1); t < Date.UTC(2031, 0, 1); t += 3600_000) {
      const d = new Date(t);
      if (kyivHour(d) !== intlHour(d)) mismatches.push(d.toISOString());
    }
    expect(mismatches).toEqual([]);
  });
});
