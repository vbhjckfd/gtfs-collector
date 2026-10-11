# day-video

Renders a vertical (1080×1920, ~54 s) timelapse of one day of Lviv public
transport from the snapshots this worker stores in R2: real GPS positions of
every tram, trolleybus and bus on the route network, a clock, per-mode counts,
a vehicles-on-line chart and a closing card with daily totals (vehicles,
kilometres driven, trips, peak).

```sh
pip install -r requirements.txt
export R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...
python3 render.py --date 2026-10-09 --out lviv-2026-10-09.mp4
python3 render.py --date 2026-10-09 --preview 08:35 --out frame.png  # single frame
```

Needs `ffmpeg` and the Inter font (`/usr/share/fonts/opentype/inter`).
Snapshots are cached under `.cache/`, so re-renders don't hit R2 again.

Notes:

- The day runs from the first vehicle seen (the collector skips 00:00–04:00).
- A vehicle is "on line" while it reports a fresh position on a trip; it is
  kept through whole-feed outages but dropped when it alone goes silent.
- Kilometres are summed from consecutive GPS fixes, dropping jumps over
  90 km/h, so they are an estimate.
- There is no city boundary offline; the land shape is grown from stop density.
