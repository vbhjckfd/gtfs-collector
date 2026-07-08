// Shared test helper: hand-encodes a minimal GTFS-RT FeedMessage so tests
// don't need a real protobuf library or a live feed sample.

function encodeVarint(n) {
  const bytes = [];
  while (n > 0x7f) {
    bytes.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  bytes.push(n);
  return Uint8Array.from(bytes);
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

// Builds a FeedMessage with a FeedHeader{timestamp} and `entityCount` empty
// FeedEntity submessages.
export function buildFeedMessage({ timestamp, entityCount = 0, version = "2.0" } = {}) {
  const chunks = [];

  if (timestamp !== undefined || version !== undefined) {
    const headerChunks = [];
    if (version !== undefined) {
      const versionBytes = new TextEncoder().encode(version);
      headerChunks.push(Uint8Array.from([0x0a]), encodeVarint(versionBytes.length), versionBytes);
    }
    if (timestamp !== undefined) {
      headerChunks.push(Uint8Array.from([0x18]), encodeVarint(timestamp));
    }
    const headerBytes = concatBytes(headerChunks);
    chunks.push(Uint8Array.from([0x0a]), encodeVarint(headerBytes.length), headerBytes);
  }

  for (let i = 0; i < entityCount; i++) {
    // empty length-delimited FeedEntity
    chunks.push(Uint8Array.from([0x12, 0x00]));
  }

  return concatBytes(chunks).buffer;
}
