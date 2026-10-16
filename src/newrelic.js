// Minimal dependency-free New Relic reporting over the raw Event API, the
// same approach as gtfs-eta's worker/newrelic.js. The New Relic Node APM
// agent can't run in a Worker (CommonJS, background harvest timers, Node
// internals), so each event is one direct POST.
//
// Events land in NRDB as their own eventType and are queryable by NRQL, e.g.
//   SELECT sum(written), sum(fetchFailed) FROM GtfsCollectorFire TIMESERIES
//   SELECT latest(outcome) FROM GtfsCollectorStatic SINCE 7 days ago
//
// Optional secret (npx wrangler secret put NEW_RELIC_LICENSE_KEY): the 40-char
// ingest licence key (starts eu01 for this account), not an NRAK-... user API
// key. Unset: nothing is reported, exactly like SENTRY_DSN gates Sentry.

// The account is in New Relic's EU region; the US collector rejects EU keys.
const EVENT_API_HOST = "https://insights-collector.eu01.nr-data.net";

const ACCOUNT_ID = "3352365";

// Tags every event, so this worker stays distinguishable in the account it
// shares with gtfs-eta, timetable-api-node and timetable-pulse.
const SERVICE_TAG = "gtfs-collector";

// Never throws: reporting must not be able to break collection.
export async function recordEvent(env, eventType, attributes) {
  const key = env.NEW_RELIC_LICENSE_KEY ?? "";
  if (!key) return;

  const accountId = env.NEW_RELIC_ACCOUNT_ID ?? ACCOUNT_ID;
  try {
    const res = await fetch(`${EVENT_API_HOST}/v1/accounts/${accountId}/events`, {
      method: "POST",
      headers: { "Api-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify([{ eventType, service: SERVICE_TAG, ...attributes }]),
      signal: AbortSignal.timeout(5000),
    });
    if (res.status >= 300) console.error(`[newrelic] event POST failed: HTTP ${res.status}`);
  } catch (err) {
    console.error(`[newrelic] failed to record ${eventType}: ${err}`);
  }
}
