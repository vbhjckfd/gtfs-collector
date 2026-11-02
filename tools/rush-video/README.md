# rush-video

Renders a vertical (1080×1920, ~13 s) clip of a short window of Lviv public
transport — 20 minutes of the morning rush by default — from the snapshots
this worker stores in R2: a dark map of the city, the route network in each
line's own colour, and every tram, trolleybus and bus moving at its recorded
GPS position, snapped onto its trip shape between fixes.

Where [`day-video`](../day-video/README.md) squeezes a whole day into a
minute, this one stays close to real time, so single vehicles can be followed.

```sh
pip install -r requirements.txt
export R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...
python3 render.py --date 2026-10-22 --start 08:00 --out lviv-rush.mp4
python3 render.py --date 2026-10-22 --start 08:00 --preview 08:10 --out frame.png  # single frame
```

Options: `--minutes` (window length, default 20), `--seconds` (video length
before the one-second hold on the last frame, default 12), `--bucket`
(default `R2_BUCKET` or `gtfs-lviv`).

Needs `ffmpeg` and macOS's Helvetica Neue (`/System/Library/Fonts/HelveticaNeue.ttc`).
Snapshots, the static feed and the basemap are cached under `.cache/`, so
re-renders don't hit R2 again.

Notes:

- The basemap is the Protomaps extract lad.lviv.ua serves
  (`tiles.lad.lviv.ua/lviv-basemap-20260828.pmtiles`, ~20 MB, downloaded once).
- The frame is fitted to the tram and trolleybus network; suburban bus lines
  run off the edges. Night lines (`Н…`) are left out.
- A vehicle is drawn while consecutive fixes are at most 3 minutes apart;
  between fixes it moves along its trip shape when both fixes snap to it
  (within 60 m), otherwise in a straight line.
- Line colours follow timetable-api's `getRouteColor`; very dark ones are
  lightened to read on the night map.
