#!/usr/bin/env python3
"""Lviv rush hour: every vehicle on line for a few minutes, real GPS.

Dark basemap from the self-hosted Protomaps extract, the route network drawn
in each line's own colour (tram/trolleybus palette from timetable-api's
getRouteColor), and every tram, trolleybus and bus moving at its recorded
GTFS-RT position, snapped onto its trip shape between fixes.

Usage:
    python3 render.py --date 2026-10-22 --start 08:00 --out lviv-rush.mp4
    python3 render.py --date 2026-10-22 --start 08:00 --preview 08:10 --out frame.png

Snapshots and the GTFS static feed in effect come from R2 (R2_ACCOUNT_ID,
R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, optionally R2_BUCKET, default
gtfs-lviv); the basemap is the lad.lviv.ua pmtiles extract. Everything is
cached under --cache, so re-renders are offline.
"""

import argparse
import bisect
import csv
import gzip
import io
import math
import os
import subprocess
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import date as Date, datetime, timedelta, timezone
from multiprocessing import Pool
from zoneinfo import ZoneInfo

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

KYIV = ZoneInfo("Europe/Kyiv")
W, H = 1080, 1920
FPS = 30
SS = 2

PMTILES_URL = "https://tiles.lad.lviv.ua/lviv-basemap-20260828.pmtiles"
WEEKDAYS = ("понеділок", "вівторок", "середа", "четвер", "п'ятниця", "субота", "неділя")

TRAM, TROLLEY, BUS = 0, 1, 2

# --- colours ----------------------------------------------------------------

BG = (20, 21, 23)
EARTH = (36, 37, 40)
GREEN = (33, 39, 35)
WATER = (16, 18, 22)
BUILDING = (41, 42, 46)
ROAD_MINOR = (48, 49, 53)
ROAD_MAJOR = (60, 61, 66)
RAIL = (55, 55, 60)

LINE_COLORS = {  # timetable-api utils/appHelpers.ts getRouteColor
    "38": "9B0A00", "33": "6F7C32", "32": "E51467", "31": "229038", "30": "EF88AA",
    "29": "323C8D", "27": "B0CB1F", "25": "E85222", "24": "E5E248", "23": "BD8260",
    "22": "3E9B7D", "09": "26602C", "08": "919191", "07": "0971B7", "06": "954592",
    "05": "FECD27", "04": "1CBBEE", "03": "50B056", "02": "93573D", "01": "E42D24",
}
BUS_COLOR = "0E4F95"


def hexrgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def lighten(c, k):
    return tuple(int(v + (255 - v) * k) for v in c)


def route_color(name, mode):
    if name.startswith("Т"):
        num = "".join(ch for ch in name if ch.isdigit())
        if num in LINE_COLORS:
            c = hexrgb(LINE_COLORS[num])
            # A few line colours are too dark to read on the night map.
            lum = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
            return lighten(c, 0.35) if lum < 90 else c
    return lighten(hexrgb(BUS_COLOR), 0.5)


# --- projection (web mercator at a fractional zoom) -------------------------


def merc(lat, lon):
    x = (np.asarray(lon) + 180.0) / 360.0
    y = (1 - np.arcsinh(np.tan(np.radians(np.asarray(lat)))) / math.pi) / 2
    return x, y


class Proj:
    def __init__(self, lat_c, lon_c, zoom, cx, cy):
        self.scale = 256 * 2 ** zoom
        self.mx, self.my = merc(lat_c, lon_c)
        self.cx, self.cy = cx, cy
        self.zoom = zoom

    def __call__(self, lat, lon):
        x, y = merc(lat, lon)
        return (x - self.mx) * self.scale + self.cx, (y - self.my) * self.scale + self.cy

    def world(self, wx, wy):  # mercator unit coords to pixels
        return (wx - self.mx) * self.scale + self.cx, (wy - self.my) * self.scale + self.cy


# --- data -------------------------------------------------------------------


def s3_client():
    import boto3

    return boto3.client(
        "s3",
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def fetch(day, t_start, t_end, cache, bucket):
    """Snapshots for the window plus MAX_GAP either side, and the static feed in effect.

    R2 keys are UTC-dated, so a window past midnight UTC spans two prefixes.
    """
    start = datetime.fromtimestamp(t_start - MAX_GAP, timezone.utc)
    end = datetime.fromtimestamp(t_end + MAX_GAP, timezone.utc)
    prefixes = sorted({f"raw/{start:%Y-%m-%d}/", f"raw/{end:%Y-%m-%d}/"})
    s3 = s3_client()
    keys = []
    for prefix in prefixes:
        for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
            for o in page.get("Contents", []):
                ts = datetime.fromisoformat(o["Key"].rsplit("/", 1)[1][:-3].replace("Z", "+00:00"))
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=timezone.utc)
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
        paths = sorted(ex.map(get, keys))
    if not paths:
        raise SystemExit("no snapshots in R2 for that window")

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


def fetch_pmtiles(cache):
    path = os.path.join(cache, os.path.basename(PMTILES_URL))
    if not os.path.exists(path):
        os.makedirs(cache, exist_ok=True)
        urllib.request.urlretrieve(PMTILES_URL, path + ".part")
        os.replace(path + ".part", path)
    return path


def plural(n, one, few, many):
    if n % 10 == 1 and n % 100 != 11:
        return one
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return few
    return many


def part_of_day(hour):
    return "ранку" if hour < 12 else "дня" if hour < 18 else "вечора"


# --- static -----------------------------------------------------------------


def load_static(path):
    z = zipfile.ZipFile(path)
    rd = lambda n: csv.DictReader(io.TextIOWrapper(z.open(n), "utf-8-sig"))
    routes = {}
    for r in rd("routes.txt"):
        name = r["route_short_name"]
        if name.startswith("Н"):  # night lines
            continue
        mode = TRAM if r["route_type"] == "0" else TROLLEY if name.startswith("Тр") else BUS
        routes[r["route_id"]] = (name, mode, route_color(name, mode))
    trips, route_shapes = {}, {}
    for r in rd("trips.txt"):
        trips[r["trip_id"]] = (r["route_id"], r["shape_id"])
        if r["route_id"] in routes:
            route_shapes.setdefault(r["route_id"], set()).add(r["shape_id"])
    pts = {}
    for r in rd("shapes.txt"):
        pts.setdefault(r["shape_id"], []).append(
            (int(r["shape_pt_sequence"]), float(r["shape_pt_lat"]), float(r["shape_pt_lon"])))
    shapes = {k: np.array([(la, lo) for _, la, lo in sorted(v)]) for k, v in pts.items()}
    return routes, trips, route_shapes, shapes


# --- shape snapping ---------------------------------------------------------

LAT0 = 49.84
MX = 111320 * math.cos(math.radians(LAT0))
MY = 110540


def to_m(latlon):
    return np.column_stack([latlon[:, 1] * MX, latlon[:, 0] * MY])


class Shape:
    def __init__(self, latlon):
        self.ll = latlon
        self.m = to_m(latlon)
        seg = np.diff(self.m, axis=0)
        self.seg = seg
        self.len2 = np.maximum((seg ** 2).sum(1), 1e-9)
        self.cum = np.concatenate([[0], np.cumsum(np.sqrt(self.len2))])

    def snap(self, lat, lon, prev=None):
        p = np.array([lon * MX, lat * MY])
        t = np.clip(((p - self.m[:-1]) * self.seg).sum(1) / self.len2, 0, 1)
        proj = self.m[:-1] + self.seg * t[:, None]
        d = np.sqrt(((proj - p) ** 2).sum(1))
        along = self.cum[:-1] + t * np.sqrt(self.len2)
        cost = d.copy()
        if prev is not None:  # loops: prefer the stretch just ahead of the last fix
            cost += np.where((along >= prev - 50) & (along <= prev + 2500), 0, 80)
        i = int(np.argmin(cost))
        return along[i], d[i]

    def at(self, s):
        i = min(max(int(np.searchsorted(self.cum, s)) - 1, 0), len(self.ll) - 2)
        a = (s - self.cum[i]) / max(self.cum[i + 1] - self.cum[i], 1e-9)
        a = min(max(a, 0), 1)
        return self.ll[i] * (1 - a) + self.ll[i + 1] * a


# --- realtime ---------------------------------------------------------------


def parse_one(path):
    from google.transit import gtfs_realtime_pb2

    feed = gtfs_realtime_pb2.FeedMessage()
    try:
        with open(path, "rb") as f:
            feed.ParseFromString(f.read())
    except Exception:
        return []
    now = feed.header.timestamp
    out = []
    for e in feed.entity:
        if not e.HasField("vehicle"):
            continue
        v = e.vehicle
        if not v.HasField("position") or not v.trip.route_id or v.position.latitude == 0:
            continue
        ts = v.timestamp or now
        if now - ts > 180:
            continue
        out.append((v.vehicle.id or e.id, ts, v.position.latitude, v.position.longitude,
                    v.trip.route_id, v.trip.trip_id))
    return out


MAX_GAP = 180


def build_tracks(paths, routes, trips, shapes):
    with Pool() as pool:
        rows = [r for chunk in pool.map(parse_one, paths) for r in chunk]
    samples = {}
    for vid, ts, lat, lon, route, trip in rows:
        if route not in routes:
            continue
        samples.setdefault(vid, {})[ts] = (lat, lon, route, trip)
    cache = {}
    tracks = []
    for vid, s in samples.items():
        ts = sorted(s)
        shape_ids, along, prev_sid, prev = [], [], None, None
        for t in ts:
            lat, lon, route, trip = s[t]
            sid = trips.get(trip, (None, None))[1]
            if sid not in shapes:
                shape_ids.append(None)
                along.append(0.0)
                continue
            if sid not in cache:
                cache[sid] = Shape(shapes[sid])
            a, d = cache[sid].snap(lat, lon, prev if sid == prev_sid else None)
            if d > 60:
                shape_ids.append(None)
                along.append(0.0)
                continue
            shape_ids.append(sid)
            along.append(a)
            prev_sid, prev = sid, a
        route = s[ts[-1]][2]
        name, mode, color = routes[route]
        tracks.append(dict(
            ts=np.array(ts, dtype=np.float64),
            ll=np.array([s[t][:2] for t in ts]),
            sid=shape_ids, along=np.array(along), mode=mode, color=color))
    return tracks, cache


def position(tr, t, shapes):
    ts = tr["ts"]
    i = bisect.bisect_right(ts, t)
    if i == 0:
        return tr["ll"][0] if ts[0] - t <= 20 else None
    if i == len(ts):
        return tr["ll"][-1] if t - ts[-1] <= 20 else None
    t0, t1 = ts[i - 1], ts[i]
    if t1 - t0 > MAX_GAP:
        return None
    a = (t - t0) / (t1 - t0)
    s0, s1 = tr["sid"][i - 1], tr["sid"][i]
    if s0 is not None and s0 == s1:
        d = tr["along"][i] - tr["along"][i - 1]
        if -30 <= d <= 2500:
            return shapes[s0].at(tr["along"][i - 1] + a * max(d, 0))
    p0, p1 = tr["ll"][i - 1], tr["ll"][i]
    # Snapped endpoints read better than raw GPS when only one side is off-shape.
    return p0 * (1 - a) + p1 * a


# --- basemap ----------------------------------------------------------------


def draw_basemap(pm_path, proj, img):
    import mapbox_vector_tile as mvt
    from pmtiles.reader import MmapSource, Reader

    z = 14
    n = 2 ** z
    tile_px = proj.scale / n
    x0w = proj.mx - proj.cx / proj.scale
    y0w = proj.my - proj.cy / proj.scale
    tx0, tx1 = int(x0w * n), int((x0w + W / proj.scale) * n)
    ty0, ty1 = int(y0w * n), int((y0w + H / proj.scale) * n)

    d = ImageDraw.Draw(img)
    layers = {k: [] for k in ("landuse", "water", "roads", "buildings", "earth")}
    with open(pm_path, "rb") as f:
        rd = Reader(MmapSource(f))
        for tx in range(tx0, tx1 + 1):
            for ty in range(ty0, ty1 + 1):
                raw = rd.get(z, tx, ty)
                if not raw:
                    continue
                if raw[:2] == b"\x1f\x8b":
                    raw = gzip.decompress(raw)
                tile = mvt.decode(raw, default_options={"y_coord_down": True})
                for name, lay in tile.items():
                    if name not in layers:
                        continue
                    ext = lay.get("extent", 4096)
                    for ft in lay["features"]:
                        layers[name].append((tx, ty, ext, ft))

    def px(tx, ty, ext, coords):
        return [((tx + x / ext) / n, (ty + y / ext) / n) for x, y in coords]

    def tr(pts):
        return [((wx - proj.mx) * proj.scale * SS + proj.cx * SS,
                 (wy - proj.my) * proj.scale * SS + proj.cy * SS) for wx, wy in pts]

    def polys(geom):
        if geom["type"] == "Polygon":
            return [geom["coordinates"]]
        if geom["type"] == "MultiPolygon":
            return geom["coordinates"]
        return []

    def lines(geom):
        if geom["type"] == "LineString":
            return [geom["coordinates"]]
        if geom["type"] == "MultiLineString":
            return geom["coordinates"]
        return []

    def fill(items, color, pred=lambda p: True):
        for tx, ty, ext, ft in items:
            if not pred(ft["properties"]):
                continue
            for poly in polys(ft["geometry"]):
                outer = tr(px(tx, ty, ext, poly[0]))
                if len(outer) > 2:
                    d.polygon(outer, fill=color)
                for hole in poly[1:]:
                    h = tr(px(tx, ty, ext, hole))
                    if len(h) > 2:
                        d.polygon(h, fill=EARTH)

    fill(layers["earth"], EARTH)
    green = {"park", "wood", "forest", "grass", "garden", "cemetery", "nature_reserve", "meadow",
             "golf_course", "recreation_ground", "village_green", "scrub", "farmland", "orchard"}
    fill(layers["landuse"], GREEN, lambda p: p.get("kind") in green)
    fill(layers["water"], WATER)
    fill(layers["buildings"], BUILDING)
    widths = {"highway": (ROAD_MAJOR, 3.2), "major_road": (ROAD_MAJOR, 2.2),
              "medium_road": (ROAD_MINOR, 1.8), "minor_road": (ROAD_MINOR, 1.2), "rail": (RAIL, 1.4)}
    for kinds in (("minor_road", "medium_road"), ("rail",), ("major_road", "highway")):
        for tx, ty, ext, ft in layers["roads"]:
            k = ft["properties"].get("kind")
            if k not in kinds:
                continue
            color, w = widths[k]
            for ln in lines(ft["geometry"]):
                d.line(tr(px(tx, ty, ext, ln)), fill=color, width=max(1, int(w * SS)), joint="curve")
    for tx, ty, ext, ft in layers["water"]:
        for ln in lines(ft["geometry"]):
            d.line(tr(px(tx, ty, ext, ln)), fill=WATER, width=2 * SS)


# --- rendering ----------------------------------------------------------------

FONT = "/System/Library/Fonts/HelveticaNeue.ttc"


def font(size, weight="Regular"):
    idx = {"Regular": 0, "Bold": 1, "Light": 7, "Medium": 10}[weight]
    return ImageFont.truetype(FONT, size, index=idx)


def make_sprite(color, r_core, r_glow, white):
    s = int(r_glow * 2 + 4) * SS
    c = s / 2
    glow = Image.new("L", (s, s), 0)
    ImageDraw.Draw(glow).ellipse((c - r_core * 1.6 * SS, c - r_core * 1.6 * SS,
                                  c + r_core * 1.6 * SS, c + r_core * 1.6 * SS), fill=150)
    glow = glow.filter(ImageFilter.GaussianBlur(r_glow * SS / 2.2))
    img = Image.new("RGBA", (s, s), color + (0,))
    img.putalpha(glow)
    core = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    cd = ImageDraw.Draw(core)
    rc = r_core * SS
    cd.ellipse((c - rc, c - rc, c + rc, c + rc), fill=lighten(color, 0.55 if white else 0.3) + (255,))
    if not white:
        img.alpha_composite(core)
        return img
    rc2 = r_core * 0.55 * SS
    cd.ellipse((c - rc2, c - rc2, c + rc2, c + rc2), fill=(255, 255, 255, 255))
    img.alpha_composite(core)
    return img


DOT = {TRAM: (5.2, 12, True), TROLLEY: (4.8, 11, True), BUS: (3.0, 6, False)}


class Renderer:
    def __init__(self, paths, static_path, pm_path, day, start, minutes):
        routes, trips, route_shapes, shapes = load_static(static_path)
        self.tracks, self.shapes = build_tracks(paths, routes, trips, shapes)
        print(f"{len(self.tracks)} vehicles")

        # Frame the city on the tram + trolleybus network; suburban buses run off the edges.
        core = np.concatenate([shapes[sid] for rid, sids in route_shapes.items()
                               if routes[rid][1] != BUS for sid in sids if sid in shapes])
        lat0, lat1 = np.percentile(core[:, 0], [1, 99])
        lon0, lon1 = np.percentile(core[:, 1], [1, 99])
        lat_c, lon_c = (lat0 + lat1) / 2, (lon0 + lon1) / 2
        mx0, _ = merc(lat_c, lon0)
        mx1, _ = merc(lat_c, lon1)
        zoom = math.log2(W * 1.14 / ((mx1 - mx0) * 256))
        self.proj = Proj(lat_c, lon_c, zoom, W / 2, 1170)
        print(f"zoom {zoom:.2f}")

        big = Image.new("RGB", (W * SS, H * SS), BG)
        draw_basemap(pm_path, self.proj, big)

        # Route network, buses under trolleybuses under trams.
        net = Image.new("RGBA", (W * SS, H * SS), (0, 0, 0, 0))
        nd = ImageDraw.Draw(net, "RGBA")
        width = {BUS: 2.0, TROLLEY: 3.6, TRAM: 4.6}
        alpha = {BUS: 150, TROLLEY: 235, TRAM: 245}
        for mode in (BUS, TROLLEY, TRAM):
            for rid, sids in route_shapes.items():
                name, m, color = routes[rid]
                if m != mode:
                    continue
                for sid in sids:
                    if sid not in shapes:
                        continue
                    x, y = self.proj(shapes[sid][:, 0], shapes[sid][:, 1])
                    nd.line(list(zip(x * SS, y * SS)), fill=color + (alpha[mode],),
                            width=int(width[mode] * SS), joint="curve")
        big = big.convert("RGBA")
        big.alpha_composite(net)
        base = big.resize((W, H), Image.LANCZOS)

        # Top and bottom shading so the type reads over the map.
        shade = np.zeros((H, 1), np.float32)
        yy = np.arange(H)
        shade[:, 0] = np.clip(1 - yy / 560, 0, 1) ** 1.6 * 0.88 + np.clip((yy - 1640) / 280, 0, 1) ** 1.5 * 0.8
        sh = Image.fromarray((np.repeat(shade, W, 1) * 255).astype(np.uint8))
        base.paste(Image.new("RGBA", (W, H), BG + (255,)), (0, 0), sh)

        d = ImageDraw.Draw(base)
        d.text((48, 318), "Львів", font=font(84, "Medium"), fill=(255, 255, 255), anchor="ls")
        d.text((48, 384), "Трамваї, тролейбуси та автобуси", font=font(42, "Light"),
               fill=(235, 235, 235), anchor="ls")
        span = f"{minutes} {plural(minutes, 'хвилина', 'хвилини', 'хвилин')} {part_of_day(start.hour)}"
        d.text((48, 428), f"кожна машина на лінії · реальні GPS-дані · {span}",
               font=font(25), fill=(130, 132, 138), anchor="ls")
        x = 48
        for i, num in enumerate(("01", "04", "30", "05", "31")):
            d.line((x + i * 9, 1830, x + i * 9 + 9, 1830), fill=hexrgb(LINE_COLORS[num]), width=5)
        d.text((x + 58, 1830), "трамваї й тролейбуси", font=font(24), fill=(170, 172, 178), anchor="lm")
        x += 58 + d.textlength("трамваї й тролейбуси", font=font(24)) + 36
        d.line((x, 1830, x + 45, 1830), fill=route_color("А01", BUS), width=2)
        d.text((x + 58, 1830), "автобуси", font=font(24), fill=(170, 172, 178), anchor="lm")
        d.text((W - 48, 1830), f"{WEEKDAYS[day.weekday()]}, {day:%d.%m.%Y}", font=font(24),
               fill=(130, 132, 138), anchor="rm")
        d.text((W / 2, 1888), "lad.lviv.ua  ·  © OpenStreetMap · Protomaps", font=font(19),
               fill=(95, 97, 102), anchor="mm")
        self.base = base

        self.sprites = {}
        for tr in self.tracks:
            key = (tr["color"], tr["mode"])
            if key not in self.sprites:
                self.sprites[key] = make_sprite(tr["color"], *DOT[tr["mode"]])


    def frame(self, t):
        img = self.base.copy()
        layer = Image.new("RGBA", (W * SS, H * SS), (0, 0, 0, 0))
        for mode in (BUS, TROLLEY, TRAM):
            for tr in self.tracks:
                if tr["mode"] != mode:
                    continue
                p = position(tr, t, self.shapes)
                if p is None:
                    continue
                x, y = self.proj(p[0], p[1])
                sp = self.sprites[(tr["color"], mode)]
                ox, oy = int(x * SS - sp.width / 2), int(y * SS - sp.height / 2)
                if -sp.width < ox < W * SS and -sp.height < oy < H * SS:
                    layer.alpha_composite(sp, (max(ox, 0), max(oy, 0)),
                                          (max(-ox, 0), max(-oy, 0)))
        layer = layer.resize((W, H), Image.LANCZOS)
        img.alpha_composite(layer)
        d = ImageDraw.Draw(img)
        clock = datetime.fromtimestamp(t, KYIV)
        d.text((W - 48, 318), f"{clock:%H:%M}", font=font(84, "Light"), fill=(255, 255, 255), anchor="rs")
        return img.convert("RGB")


R = None


def _init(r):
    global R
    R = r


def _render(t):
    return R.frame(t).tobytes()


def kyiv_time(day, hhmm):
    hh, mm, *ss = map(int, hhmm.split(":"))
    return datetime(day.year, day.month, day.day, hh, mm, ss[0] if ss else 0, tzinfo=KYIV)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", required=True, help="Kyiv date, YYYY-MM-DD")
    ap.add_argument("--start", default="08:00", help="Kyiv HH:MM the window starts at")
    ap.add_argument("--minutes", type=int, default=20, help="length of the window")
    ap.add_argument("--seconds", type=float, default=12, help="length of the video, before the 1 s hold")
    ap.add_argument("--out", default=None)
    ap.add_argument("--cache", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache"))
    ap.add_argument("--bucket", default=os.environ.get("R2_BUCKET", "gtfs-lviv"))
    ap.add_argument("--preview", help="render a single PNG at this Kyiv HH:MM[:SS] instead of the video")
    args = ap.parse_args()

    day = Date.fromisoformat(args.date)
    start = kyiv_time(day, args.start)
    t_start = start.timestamp()
    t_end = t_start + args.minutes * 60
    out = args.out or f"lviv-rush-{day}-{start:%H%M}.{'png' if args.preview else 'mp4'}"
    paths, static_path = fetch(day, t_start, t_end, args.cache, args.bucket)
    r = Renderer(paths, static_path, fetch_pmtiles(args.cache), day, start, args.minutes)
    if args.preview:
        r.frame(kyiv_time(day, args.preview).timestamp()).save(out)
        print(out)
        return
    n = int(args.seconds * FPS)
    times = [t_start + (t_end - t_start) * i / (n - 1) for i in range(n)]
    times += [t_end] * FPS  # one-second hold on the last frame
    ff = subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
         "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "slow",
         "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out],
        stdin=subprocess.PIPE)
    with Pool(initializer=_init, initargs=(r,)) as pool:
        for i, buf in enumerate(pool.imap(_render, times, chunksize=4)):
            ff.stdin.write(buf)
            if i % 60 == 0:
                print(f"frame {i}/{len(times)}")
    ff.stdin.close()
    ff.wait()
    print(out)


if __name__ == "__main__":
    main()
