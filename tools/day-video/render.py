#!/usr/bin/env python3
"""Render a vertical "one day of Lviv public transport" timelapse video.

Pulls every GTFS-RT snapshot the collector stored for one day from R2, plus
the GTFS static feed that was in effect, and renders a 1080x1920 MP4: live
vehicle positions on the route network, a clock, per-mode counts, a
vehicles-on-line chart across the day and a closing card with daily totals.

Usage:
    python3 render.py --date 2026-10-09 --out lviv-2026-10-09.mp4

R2 credentials come from R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
R2_SECRET_ACCESS_KEY (and optionally R2_BUCKET, default gtfs-lviv).
Downloads are cached under --cache so re-renders are offline.
"""

import argparse
import bisect
import csv
import io
import math
import os
import subprocess
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import date as Date, datetime, timedelta, timezone
from multiprocessing import Pool
from zoneinfo import ZoneInfo

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

KYIV = ZoneInfo("Europe/Kyiv")

# --- look ---------------------------------------------------------------

W, H = 1080, 1920
FPS = 30
BG = (244, 237, 227)
LAND = (232, 222, 206)
LAND_EDGE = (214, 200, 178)
NET = (212, 198, 175)
NAVY = (28, 43, 75)
ORANGE = (240, 138, 36)
MUTED = (122, 128, 153)
TRACK = (226, 216, 200)

TRAM, TROLLEY, BUS = 0, 1, 2
MODES = [
    # (label, color, dot radius)
    ("Трамваї", NAVY, 6.0),
    ("Тролейбуси", ORANGE, 6.0),
    ("Автобуси", (110, 120, 145), 4.5),
]
DRAW_ORDER = [BUS, TROLLEY, TRAM]

FONT_DIR = "/usr/share/fonts/opentype/inter"


def font(weight, size):
    return ImageFont.truetype(os.path.join(FONT_DIR, f"Inter-{weight}.otf"), size)


WEEKDAYS = ["понеділок", "вівторок", "середа", "четвер", "п'ятниця", "субота", "неділя"]
WEEKDAYS_ACC = ["ПОНЕДІЛОК", "ВІВТОРОК", "СЕРЕДУ", "ЧЕТВЕР", "П'ЯТНИЦЮ", "СУБОТУ", "НЕДІЛЮ"]


def plural(n, one, few, many):
    if n % 10 == 1 and n % 100 != 11:
        return one
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return few
    return many


def fmt_int(n):
    return f"{int(round(n)):,}".replace(",", " ")


# --- data ---------------------------------------------------------------


def s3_client():
    import boto3

    return boto3.client(
        "s3",
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def utc_prefixes(day):
    """R2 keys are UTC-dated; a Kyiv day spans two UTC dates."""
    start = datetime(day.year, day.month, day.day, tzinfo=KYIV).astimezone(timezone.utc)
    end = start + timedelta(days=1)
    return sorted({f"raw/{start:%Y-%m-%d}/", f"raw/{(end - timedelta(seconds=1)):%Y-%m-%d}/"}), start, end


def fetch(day, cache, bucket):
    prefixes, start, end = utc_prefixes(day)
    s3 = s3_client()
    keys = []
    for prefix in prefixes:
        for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
            for o in page.get("Contents", []):
                ts = datetime.fromisoformat(o["Key"].rsplit("/", 1)[1][:-3].replace("Z", "+00:00"))
                if start <= ts < end:
                    keys.append(o["Key"])

    def get(key):
        path = os.path.join(cache, key)
        if not os.path.exists(path):
            os.makedirs(os.path.dirname(path), exist_ok=True)
            s3.download_file(bucket, key, path + ".part")
            os.replace(path + ".part", path)
        return path

    with ThreadPoolExecutor(32) as ex:
        paths = list(ex.map(get, keys))

    # Newest static snapshot dated on or before the day.
    static_keys = []
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix="static/"):
        static_keys += [o["Key"] for o in page.get("Contents", []) if o["Key"].endswith("/static.zip")]
    static_keys = sorted(k for k in static_keys if k.split("/")[1] <= day.isoformat())
    if not static_keys:
        raise SystemExit("no static feed archived on or before " + day.isoformat())
    static_path = get(static_keys[-1])
    print(f"{len(paths)} snapshots, static {static_keys[-1]}")
    return paths, static_path


def load_static(path):
    z = zipfile.ZipFile(path)
    rd = lambda name: csv.DictReader(io.TextIOWrapper(z.open(name), "utf-8-sig"))
    route_mode = {}
    for r in rd("routes.txt"):
        name = r["route_short_name"]
        if r["route_type"] == "0":
            route_mode[r["route_id"]] = TRAM
        elif name.startswith("Тр"):
            route_mode[r["route_id"]] = TROLLEY
        else:
            route_mode[r["route_id"]] = BUS
    shapes = {}
    for r in rd("shapes.txt"):
        shapes.setdefault(r["shape_id"], []).append(
            (int(r["shape_pt_sequence"]), float(r["shape_pt_lat"]), float(r["shape_pt_lon"]))
        )
    shapes = [np.array([(la, lo) for _, la, lo in sorted(pts)]) for pts in shapes.values()]
    stops = np.array([(float(r["stop_lat"]), float(r["stop_lon"])) for r in rd("stops.txt")])
    return route_mode, shapes, stops


def parse_one(path):
    from google.transit import gtfs_realtime_pb2

    feed = gtfs_realtime_pb2.FeedMessage()
    try:
        with open(path, "rb") as f:
            feed.ParseFromString(f.read())
    except Exception:  # a truncated upstream response; one missing 10s step is harmless
        return None, []
    now = feed.header.timestamp
    out = []
    for e in feed.entity:
        if not e.HasField("vehicle"):
            continue
        v = e.vehicle
        if not v.HasField("position") or not v.trip.route_id:
            continue
        ts = v.timestamp or now
        if now - ts > 180:  # stale position: vehicle not really reporting
            continue
        out.append((v.vehicle.id or e.id, ts, v.position.latitude, v.position.longitude,
                    v.trip.route_id, v.trip.trip_id))
    return now, out


def load_tracks(paths, route_mode):
    with Pool() as pool:
        parsed = list(pool.imap(parse_one, paths, chunksize=32))
    rows = [r for _, chunk in parsed for r in chunk]
    # Times the feed was actually alive (had fresh vehicles). A vehicle missing
    # while the whole feed was down is still on line; one missing while the
    # feed was fine has left it.
    alive = np.array(sorted({now for now, chunk in parsed if chunk}), dtype=np.float64)
    tracks = {}
    trips = set()
    for vid, ts, lat, lon, route, trip in rows:
        mode = route_mode.get(route)
        if mode is None or lat == 0:
            continue
        tracks.setdefault(vid, {})[ts] = (lat, lon, mode)
        trips.add(trip)
    out = []
    for vid, samples in tracks.items():
        ts = sorted(samples)
        arr = np.array([samples[t][:2] for t in ts])
        modes = np.array([samples[t][2] for t in ts], dtype=np.int8)
        ts = np.array(ts, dtype=np.float64)
        dt = np.diff(ts)
        seen = np.searchsorted(alive, ts[1:] - MAX_GAP / 2) - np.searchsorted(alive, ts[:-1] + MAX_GAP / 2)
        ok = (dt <= MAX_GAP) | ((dt <= 1800) & (seen <= 0))
        out.append((ts, arr, modes, ok))
    return out, len(trips)


MAX_GAP = 180  # seconds between samples before we stop interpolating


def positions_at(tracks, t):
    """Interpolated (lat, lon, mode) of every vehicle on line at time t."""
    res = []
    for ts, xy, modes, ok in tracks:
        i = bisect.bisect_right(ts, t)
        if i == 0:
            if ts[0] - t <= 30:
                res.append((xy[0, 0], xy[0, 1], modes[0]))
            continue
        if i == len(ts):
            if t - ts[-1] <= 30:
                res.append((xy[-1, 0], xy[-1, 1], modes[-1]))
            continue
        if not ok[i - 1]:
            continue
        t0, t1 = ts[i - 1], ts[i]
        a = (t - t0) / (t1 - t0)
        p = xy[i - 1] * (1 - a) + xy[i] * a
        res.append((p[0], p[1], modes[i - 1]))
    return res


def haversine_km(a, b):
    la1, lo1, la2, lo2 = map(np.radians, (a[:, 0], a[:, 1], b[:, 0], b[:, 1]))
    h = np.sin((la2 - la1) / 2) ** 2 + np.cos(la1) * np.cos(la2) * np.sin((lo2 - lo1) / 2) ** 2
    return 6371.0 * 2 * np.arcsin(np.sqrt(h))


def total_km(tracks):
    km = 0.0
    for ts, xy, _, ok in tracks:
        if len(ts) < 2:
            continue
        d = haversine_km(xy[:-1], xy[1:])
        dt = np.diff(ts)
        ok = ok & (d / np.maximum(dt, 1) * 3600 < 90)  # drop GPS jumps
        km += d[ok].sum()
    return km


# --- drawing ------------------------------------------------------------


class Projection:
    def __init__(self, tracks, box):
        pts = np.concatenate([t[1] for t in tracks])
        lat0, lat1 = np.percentile(pts[:, 0], [0.5, 99.5])
        lon0, lon1 = np.percentile(pts[:, 1], [0.5, 99.5])
        self.k = math.cos(math.radians((lat0 + lat1) / 2))
        x0, y0, x1, y1 = box
        sw, sh = (lon1 - lon0) * self.k, lat1 - lat0
        self.s = min((x1 - x0) / sw, (y1 - y0) / sh) * 0.94
        self.cx, self.cy = (x0 + x1) / 2, (y0 + y1) / 2
        self.lon_c, self.lat_c = (lon0 + lon1) / 2, (lat0 + lat1) / 2

    def __call__(self, lat, lon):
        return (self.cx + (lon - self.lon_c) * self.k * self.s,
                self.cy - (lat - self.lat_c) * self.s)


def gaussian_blur(a, sigma):
    r = int(sigma * 3)
    t = np.arange(-r, r + 1)
    k = np.exp(-t * t / (2 * sigma * sigma))
    k /= k.sum()
    a = np.apply_along_axis(lambda v: np.convolve(v, k, "same"), 1, a)
    return np.apply_along_axis(lambda v: np.convolve(v, k, "same"), 0, a)


SS = 2  # supersampling for the map layer


def draw_center(d, y, text, f, fill, tracking=0):
    if tracking:
        widths = [d.textlength(c, font=f) + tracking for c in text]
        x = (W - sum(widths) + tracking) / 2
        for c, w in zip(text, widths):
            d.text((x, y), c, font=f, fill=fill)
            x += w
    else:
        d.text((W / 2, y), text, font=f, fill=fill, anchor="mt")


def fit_font(d, text, weight, size, max_w):
    while size > 10 and d.textlength(text, font=font(weight, size)) > max_w:
        size -= 2
    return font(weight, size)


class Renderer:
    MAP = (30, 600, W - 30, 1360)
    LEGEND_Y = 1395
    CHART = (110, 1640, W - 110, 1760)

    def __init__(self, day, tracks, shapes, stops, t0, t1, series, n_trips):
        self.stops = stops
        self.day, self.tracks, self.t0, self.t1 = day, tracks, t0, t1
        self.series = series  # (times, counts[mode, i])
        self.n_trips = n_trips
        self.proj = Projection(tracks, self.MAP)
        self.peak = max(series[1].sum(axis=0).max(), 1)
        self.bar_max = max(series[1].max(), 1)
        self.base = self._base(shapes)

    def _base(self, shapes):
        img = Image.new("RGB", (W, H), BG)
        d = ImageDraw.Draw(img)
        draw_center(d, 62, "ГРОМАДСЬКИЙ ТРАНСПОРТ ЛЬВОВА", font("SemiBold", 24), MUTED, tracking=4)
        draw_center(d, 102, "ОДИН ДЕНЬ", font("ExtraBold", 96), NAVY)
        f = fit_font(d, "ТРАНСПОРТУ ЛЬВОВА", "ExtraBold", 84, W - 120)
        draw_center(d, 206, "ТРАНСПОРТУ ЛЬВОВА", f, ORANGE)
        d.rounded_rectangle((W / 2 - 140, 318, W / 2 + 140, 324), 3, fill=NAVY)

        # Land: no boundary data offline, so grow a smooth blob where stops
        # are dense (the built-up city), and fade it out at the map edges.
        x0, y0, x1, y1 = self.MAP
        mw, mh = (x1 - x0), (y1 - y0)
        lines = [[(x - x0, y - y0) for x, y in (self.proj(la, lo) for la, lo in s)] for s in shapes]
        density = np.zeros((mh, mw))
        for la, lo in self.stops:
            x, y = self.proj(la, lo)
            if 0 <= x - x0 < mw and 0 <= y - y0 < mh:
                density[int(y - y0), int(x - x0)] += 1
        density = gaussian_blur(density, 40)
        mask = Image.fromarray(((density > density.max() * 0.13) * 255).astype(np.uint8))
        mask = mask.filter(ImageFilter.GaussianBlur(2))
        fade = Image.new("L", (mw, mh), 0)
        ImageDraw.Draw(fade).rounded_rectangle((40, 40, mw - 40, mh - 40), 60, fill=255)
        fade = fade.filter(ImageFilter.GaussianBlur(30))
        mask = Image.fromarray((np.asarray(mask, np.float32) * np.asarray(fade, np.float32) / 255).astype(np.uint8))
        edge = mask.filter(ImageFilter.MaxFilter(5))
        img.paste(LAND_EDGE, (x0, y0), edge)
        img.paste(LAND, (x0, y0), mask)

        net = Image.new("L", (mw * SS, mh * SS), 0)
        nd = ImageDraw.Draw(net)
        for pts in lines:
            nd.line([(x * SS, y * SS) for x, y in pts], fill=255, width=2 * SS, joint="curve")
        net = net.resize((mw, mh), Image.LANCZOS)
        net = Image.fromarray((np.asarray(net, np.float32) * np.asarray(fade, np.float32) / 255).astype(np.uint8))
        img.paste(NET, (x0, y0), net)

        ly = self.LEGEND_Y
        for m, (label, color, _) in enumerate(MODES):
            y = ly + m * 54
            d.ellipse((120, y + 8, 138, y + 26), fill=color)
            d.text((156, y + 17), label, font=font("SemiBold", 32), fill=NAVY, anchor="lm")
            d.rounded_rectangle((560, y + 12, 840, y + 22), 5, fill=TRACK)

        draw_center(d, self.CHART[1] - 50, "МАШИН НА ЛІНІЇ ПРОТЯГОМ ДНЯ", font("SemiBold", 22), MUTED, tracking=3)
        cx0, _, cx1, cy1 = self.CHART
        lab = font("Medium", 20)
        start_h = datetime.fromtimestamp(self.t0, KYIV).hour
        for h in range(start_h, 25, 4):
            x = self._chart_x(self.t0 + (h - start_h) * 3600)
            d.line((x, cy1, x, cy1 + 6), fill=MUTED, width=2)
            d.text((x, cy1 + 12), f"{h:02d}:00", font=lab, fill=MUTED, anchor="mt")
        self.chart_poly = self._chart_poly()
        d.polygon(self.chart_poly, fill=TRACK)
        d.line((cx0, cy1, cx1, cy1), fill=MUTED, width=2)

        wd = WEEKDAYS[self.day.weekday()]
        src = f"Джерело: GPS-трекінг (GTFS-RT) · {wd} {self.day.day}.{self.day.month}.{self.day.year}"
        draw_center(d, 1806, src, font("Medium", 22), MUTED)
        pill = font("Bold", 30)
        tw = d.textlength("lad.lviv.ua", font=pill)
        d.rounded_rectangle((W / 2 - tw / 2 - 30, 1846, W / 2 + tw / 2 + 30, 1896), 25, fill=NAVY)
        d.text((W / 2 - tw / 2, 1871), "lad.", font=pill, fill=(255, 255, 255), anchor="lm")
        d.text((W / 2 - tw / 2 + d.textlength("lad.", font=pill), 1871), "lviv.ua", font=pill, fill=ORANGE, anchor="lm")
        return img

    def _chart_x(self, t):
        x0, _, x1, _ = self.CHART
        return x0 + (t - self.t0) / (self.t1 - self.t0) * (x1 - x0)

    def _chart_poly(self, upto=None):
        x0, y0, x1, y1 = self.CHART
        times, counts = self.series
        total = counts.sum(axis=0)
        pts = [(self._chart_x(times[0]), y1)]
        for t, c in zip(times, total):
            if upto is not None and t > upto:
                pts.append((self._chart_x(upto), y1 - c / self.peak * (y1 - y0)))
                break
            pts.append((self._chart_x(t), y1 - c / self.peak * (y1 - y0)))
        pts.append((pts[-1][0], y1))
        return pts

    def counts_at(self, t):
        times, counts = self.series
        i = min(max(bisect.bisect_left(times, t), 0), len(times) - 1)
        return counts[:, i]

    def frame(self, t, trail_dt, overlay=None):
        img = self.base.copy()
        d = ImageDraw.Draw(img, "RGBA")
        clock = datetime.fromtimestamp(min(t, self.t1 - 1), KYIV)
        label = "24:00" if t >= self.t1 - 1 else f"{clock:%H:%M}"
        draw_center(d, 350, label, font("ExtraBold", 150), NAVY)

        counts = self.counts_at(t)
        n = int(counts.sum())
        f_num, f_txt = font("Bold", 34), font("Medium", 34)
        num, txt = fmt_int(n), f"  {plural(n, 'машина', 'машини', 'машин')} зараз на лінії"
        w = d.textlength(num, font=f_num) + d.textlength(txt, font=f_txt)
        x = (W - w) / 2
        d.text((x, 530), num, font=f_num, fill=ORANGE, anchor="ls")
        d.text((x + d.textlength(num, font=f_num), 530), txt, font=f_txt, fill=MUTED, anchor="ls")

        # Map layer, supersampled for smooth dots.
        x0, y0, x1, y1 = self.MAP
        layer = Image.new("RGBA", ((x1 - x0) * SS, (y1 - y0) * SS), (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer, "RGBA")
        trails = [(positions_at(self.tracks, t - k * trail_dt), 1 - k / 5) for k in (4, 3, 2, 1)]
        now = positions_at(self.tracks, t)
        for mode in DRAW_ORDER:
            _, color, r = MODES[mode]
            for pos, fade in trails:
                rr = r * 0.6 * SS
                for la, lo, m in pos:
                    if m != mode:
                        continue
                    px, py = self.proj(la, lo)
                    px, py = (px - x0) * SS, (py - y0) * SS
                    ld.ellipse((px - rr, py - rr, px + rr, py + rr), fill=color + (int(70 * fade),))
            rr = r * SS
            for la, lo, m in now:
                if m != mode:
                    continue
                px, py = self.proj(la, lo)
                px, py = (px - x0) * SS, (py - y0) * SS
                ld.ellipse((px - rr, py - rr, px + rr, py + rr), fill=color + (235,))
        layer = layer.resize((x1 - x0, y1 - y0), Image.LANCZOS)
        img.paste(layer, (x0, y0), layer)

        for m, (_, color, _) in enumerate(MODES):
            y = self.LEGEND_Y + m * 54
            c = int(counts[m])
            if c:
                d.rounded_rectangle((560, y + 12, 560 + max(10, 280 * c / self.bar_max), y + 22), 5, fill=color)
            d.text((960, y + 17), fmt_int(c), font=font("Bold", 32), fill=ORANGE if c else MUTED, anchor="rm")

        poly = self._chart_poly(upto=t)
        if len(poly) > 3:
            d.polygon(poly, fill=NAVY)
        cx = self._chart_x(min(t, self.t1))
        _, cy0, _, cy1 = self.CHART
        top = poly[-2][1] if len(poly) > 3 else cy1
        d.line((cx, top, cx, cy1), fill=ORANGE, width=3)
        d.ellipse((cx - 8, top - 8, cx + 8, top + 8), fill=ORANGE)

        if overlay is not None:
            self._card(img, overlay)
        return img

    def _card(self, img, p):
        """Closing card; p in [0, 1] drives fade-in and count-up."""
        a = min(1.0, p * 4)
        veil = Image.new("RGBA", (W, H), BG + (int(200 * a),))
        x0, y0, x1, y1 = self.MAP
        img.paste(veil.crop((x0, y0, x1, y1)), (x0, y0), veil.crop((x0, y0, x1, y1)))
        d = ImageDraw.Draw(img, "RGBA")
        bx0, by0, bx1, by1 = 150, 680, W - 150, 1290
        d.rounded_rectangle((bx0, by0, bx1, by1), 28, fill=BG + (int(255 * a),),
                            outline=NAVY + (int(255 * a),), width=3)
        if a < 1:
            return
        grow = min(1.0, max(0.0, (p - 0.25) / 0.4))
        grow = 1 - (1 - grow) ** 3
        draw_center(d, by0 + 50, f"ЗА ОДНУ {WEEKDAYS_ACC[self.day.weekday()]}", font("SemiBold", 26), MUTED, tracking=3)
        n_veh = len(self.tracks)
        draw_center(d, by0 + 100, fmt_int(n_veh * grow), font("ExtraBold", 110), ORANGE)
        draw_center(d, by0 + 228, plural(n_veh, "машина вийшла на лінію", "машини вийшли на лінію",
                                         "машин вийшли на лінію"), font("Medium", 32), NAVY)
        d.rounded_rectangle((W / 2 - 110, by0 + 290, W / 2 + 110, by0 + 295), 3, fill=NAVY)
        draw_center(d, by0 + 325, f"{fmt_int(self.km * grow)} км", font("ExtraBold", 96), NAVY)
        draw_center(d, by0 + 440, f"≈ {self.km / 40075:.1f}× навколо Землі".replace(".", ","),
                    font("Medium", 32), MUTED)
        draw_center(d, by0 + 500, f"{fmt_int(self.n_trips)} рейсів · пік {fmt_int(self.peak)} о {self.peak_at}",
                    font("Medium", 30), MUTED)


R = None


def _init(state):
    global R
    R = state


def _render(job):
    i, t, trail_dt, overlay = job
    return R.frame(t, trail_dt, overlay).tobytes()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", required=True, help="Kyiv date, YYYY-MM-DD")
    ap.add_argument("--out", default=None)
    ap.add_argument("--cache", default=os.path.join(os.path.dirname(__file__), ".cache"))
    ap.add_argument("--bucket", default=os.environ.get("R2_BUCKET", "gtfs-lviv"))
    ap.add_argument("--seconds", type=float, default=48, help="length of the day part of the video")
    ap.add_argument("--card-seconds", type=float, default=6)
    ap.add_argument("--preview", help="render a single PNG at this Kyiv HH:MM instead of the video")
    args = ap.parse_args()

    day = Date.fromisoformat(args.date)
    out = args.out or f"lviv-{day}.mp4"
    paths, static_path = fetch(day, args.cache, args.bucket)
    route_mode, shapes, stops = load_static(static_path)
    tracks, n_trips = load_tracks(paths, route_mode)
    print(f"{len(tracks)} vehicles")

    # Animate from the first to the last snapshot (collector skips 00:00-04:00).
    t_first = min(t[0][0] for t in tracks)
    t_last = max(t[0][-1] for t in tracks)
    t0 = datetime.fromtimestamp(t_first, KYIV).replace(minute=0, second=0).timestamp()
    t1 = min(datetime(day.year, day.month, day.day, tzinfo=KYIV).timestamp() + 86400,
             datetime.fromtimestamp(t_last, KYIV).replace(minute=0, second=0).timestamp() + 3600)

    times = np.arange(t0, t1 + 1, 60.0)
    counts = np.zeros((3, len(times)), dtype=np.int32)
    for i, t in enumerate(times):
        for _, _, m in positions_at(tracks, t):
            counts[m, i] += 1
    # Light smoothing so the chart and bars don't flicker on feed gaps.
    k = np.ones(5) / 5
    counts = np.vstack([np.convolve(c, k, mode="same") for c in counts]).round().astype(np.int32)

    r = Renderer(day, tracks, shapes, stops, t0, t1, (times, counts), n_trips)
    r.km = total_km(tracks)
    total = counts.sum(axis=0)
    r.peak = int(total.max())
    r.peak_at = f"{datetime.fromtimestamp(times[int(total.argmax())], KYIV):%H:%M}"
    print(f"peak {r.peak} at {r.peak_at}, {r.km:.0f} km, {n_trips} trips")

    if args.preview:
        hh, mm = map(int, args.preview.split(":"))
        t = datetime(day.year, day.month, day.day, hh, mm, tzinfo=KYIV).timestamp()
        step = (t1 - t0) / (args.seconds * FPS)
        r.frame(t, step).save(out)
        print(out)
        return

    n_day = int(args.seconds * FPS)
    step = (t1 - t0) / n_day
    jobs = [(i, t0 + i * step, step, None) for i in range(n_day + 1)]
    n_card = int(args.card_seconds * FPS)
    jobs += [(n_day + 1 + i, t1, step, i / n_card) for i in range(n_card)]

    ff = subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
         "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "slow",
         "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out],
        stdin=subprocess.PIPE,
    )
    with Pool(initializer=_init, initargs=(r,)) as pool:
        for i, buf in enumerate(pool.imap(_render, jobs, chunksize=4)):
            ff.stdin.write(buf)
            if i % 150 == 0:
                print(f"frame {i}/{len(jobs)}")
    ff.stdin.close()
    ff.wait()
    print(out)


if __name__ == "__main__":
    main()
