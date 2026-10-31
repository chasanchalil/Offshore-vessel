#!/usr/bin/env python3
"""
Vessel Tracker – cloud collector (runs in GitHub Actions; each run listens ~55 min and saves every 15 min).
Listens to AISStream.io continuously for RUN_MINUTES and every 15 min appends one position per vessel
to data/positions_YYYY-MM.csv and refreshes data/latest.json.
"""
import asyncio
import csv
import urllib.request
import urllib.parse
import json
import os
import sys
import time
from datetime import datetime, timezone

import websockets

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
URL = "wss://stream.aisstream.io/v0/stream"
KEY = os.environ.get("AISSTREAM_API_KEY", "").strip()
RUN_MINUTES = float(os.environ.get("RUN_MINUTES", "55"))  # one run listens continuously this long
SLOT_MIN = float(os.environ.get("SLOT_MIN", "15"))  # one saved position per vessel per 15-min slot
POS_TYPES = {"PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport"}
FIELDS = ["ts_utc", "mmsi", "lat", "lon", "sog", "cog", "heading", "nav_status"]
WX_FIELDS = ["ts_utc", "mmsi", "lat", "lon", "wind_ms", "gust_ms", "wind_dir", "hs_m", "tp_s", "wave_dir", "swell_m"]
WX_EVERY_MIN = 55  # weather is model data (hourly) – fetch once per hour
# Weather: Open-Meteo free API (non-commercial use only, CC BY 4.0) – https://open-meteo.com


def now():
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso(dt):
    return dt.isoformat().replace("+00:00", "Z")


def num(v, bad=None, maxv=None):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    if (bad is not None and v == bad) or (maxv is not None and v >= maxv):
        return None
    return round(v, 6)


def parse(msg, pos, static):
    mtype = msg.get("MessageType")
    meta = msg.get("MetaData") or {}
    mmsi = str(meta.get("MMSI", "")).strip()
    body = (msg.get("Message") or {}).get(mtype) or {}
    if not mmsi:
        return
    if mtype in POS_TYPES:
        lat = num(body.get("Latitude", meta.get("latitude")), maxv=91)
        lon = num(body.get("Longitude", meta.get("longitude")), maxv=181)
        if lat is None or lon is None:
            return
        pos[mmsi] = {"ts_utc": iso(now()), "mmsi": mmsi, "lat": lat, "lon": lon,
                     "sog": num(body.get("Sog"), maxv=102.3), "cog": num(body.get("Cog"), maxv=360),
                     "heading": num(body.get("TrueHeading"), bad=511),
                     "nav_status": body.get("NavigationalStatus")}
    elif mtype == "ShipStaticData":
        dim = body.get("Dimension") or {}
        eta = body.get("Eta") or {}
        s = {"ais_name": (body.get("Name") or "").strip(),
             "imo": str(body.get("ImoNumber") or ""),
             "callsign": (body.get("CallSign") or "").strip(),
             "ship_type": body.get("Type"),
             "destination": (body.get("Destination") or "").strip(),
             "draught": num(body.get("MaximumStaticDraught")),
             "length": (dim.get("A", 0) + dim.get("B", 0)) or None,
             "beam": (dim.get("C", 0) + dim.get("D", 0)) or None}
        if eta.get("Month") and eta.get("Day"):
            s["eta"] = f"{eta['Day']:02d}/{eta['Month']:02d} {eta.get('Hour', 0):02d}:{eta.get('Minute', 0):02d} UTC"
        static[mmsi] = {k: v for k, v in s.items() if v not in (None, "", "0")}


def git_save(msg):
    """Commit and push data/ (only inside GitHub Actions)."""
    if not os.environ.get("GITHUB_ACTIONS"):
        return
    import subprocess
    run = lambda *a: subprocess.run(list(a), cwd=ROOT, capture_output=True, text=True, timeout=120)
    run("git", "add", "data")
    if run("git", "diff", "--cached", "--quiet").returncode == 0:
        return
    run("git", "commit", "-m", msg)
    for _ in range(3):
        run("git", "pull", "--rebase", "-X", "theirs")
        r = run("git", "push")
        if r.returncode == 0:
            print("pushed:", msg)
            return
        time.sleep(5)
    print("push failed:", r.stderr[-300:])


async def listen(mmsis, on_slot):
    """Listen continuously for RUN_MINUTES; call on_slot(pos, static) every SLOT_MIN (aligned to :00/:15/:30/:45)."""
    sub = {"APIKey": KEY, "BoundingBoxes": [[[-90, -180], [90, 180]]], "FiltersShipMMSI": mmsis,
           "FilterMessageTypes": sorted(POS_TYPES | {"ShipStaticData"})}
    deadline = time.time() + RUN_MINUTES * 60
    slot = SLOT_MIN * 60
    slot_end = (int(time.time()) // slot + 1) * slot
    pos, static = {}, {}

    def flush():
        nonlocal pos, static, slot_end
        on_slot(pos, static)
        pos, static = {}, {}
        slot_end += slot

    while time.time() < deadline:
        try:
            async with websockets.connect(URL, open_timeout=30, ping_interval=20, ping_timeout=60,
                                          max_size=2 ** 22) as ws:
                await ws.send(json.dumps(sub))
                print("connected")
                while time.time() < deadline:
                    wait = min(slot_end, deadline) - time.time()
                    if time.time() >= slot_end:
                        flush()
                        continue
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=max(0.5, wait))
                    except asyncio.TimeoutError:
                        continue
                    msg = json.loads(raw)
                    if isinstance(msg, dict) and msg.get("error"):
                        print("AISStream error:", msg["error"])
                        sys.exit(1)
                    parse(msg, pos, static)
        except (OSError, websockets.exceptions.WebSocketException, asyncio.TimeoutError) as e:
            print("connection dropped:", e)
            await asyncio.sleep(10)
            if time.time() >= slot_end and time.time() < deadline:
                flush()
    on_slot(pos, static)  # final (partial) slot


def _get_json(base, params):
    url = base + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "vessel-tracker (personal, non-commercial)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.loads(r.read())
    return data if isinstance(data, list) else [data]


def fetch_weather(points):
    """points: list of (mmsi, lat, lon). One multi-location request per API, max 45 points."""
    if not points:
        return []
    lats = ",".join(f"{p[1]:.3f}" for p in points)
    lons = ",".join(f"{p[2]:.3f}" for p in points)
    out = []
    try:
        wind = _get_json("https://api.open-meteo.com/v1/forecast",
                         {"latitude": lats, "longitude": lons, "wind_speed_unit": "ms",
                          "current": "wind_speed_10m,wind_direction_10m,wind_gusts_10m"})
    except Exception as e:
        print("wind request failed:", e)
        wind = [{}] * len(points)
    try:
        sea = _get_json("https://marine-api.open-meteo.com/v1/marine",
                        {"latitude": lats, "longitude": lons,
                         "current": "wave_height,wave_direction,wave_period,swell_wave_height"})
    except Exception as e:
        print("marine request failed:", e)
        sea = [{}] * len(points)
    ts = iso(now())
    for (mmsi, lat, lon), w, s in zip(points, wind, sea):
        wc, sc = (w or {}).get("current") or {}, (s or {}).get("current") or {}
        row = {"ts_utc": ts, "mmsi": mmsi, "lat": lat, "lon": lon,
               "wind_ms": wc.get("wind_speed_10m"), "gust_ms": wc.get("wind_gusts_10m"),
               "wind_dir": wc.get("wind_direction_10m"), "hs_m": sc.get("wave_height"),
               "tp_s": sc.get("wave_period"), "wave_dir": sc.get("wave_direction"),
               "swell_m": sc.get("swell_wave_height")}
        if any(row[k] is not None for k in ("wind_ms", "hs_m")):
            out.append(row)
    return out


WF_URL = ("https://ows.emodnet-humanactivities.eu/wfs?service=WFS&version=1.0.0&request=GetFeature"
          "&typeName=emodnet:windfarmspoly&outputFormat=application/json&srsName=EPSG:4326")
WF_MAX_AGE_DAYS = 7  # EMODnet Human Activities wind farm polygons (CC BY 4.0, CETMAR) – refreshed weekly


def _round_coords(c):
    if isinstance(c, (int, float)):
        return round(c, 4)
    return [_round_coords(x) for x in c]


def _first_xy(c):
    while isinstance(c, list) and c and isinstance(c[0], list):
        c = c[0]
    return c


def _swap(c):
    if c and isinstance(c[0], (int, float)):
        return [c[1], c[0]] + c[2:]
    return [_swap(x) for x in c]


def update_windfarms():
    path = os.path.join(DATA, "windfarms.geojson")
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < WF_MAX_AGE_DAYS * 86400 \
            and not os.environ.get("FORCE_WINDFARMS"):
        return
    try:
        req = urllib.request.Request(WF_URL, headers={"User-Agent": "vessel-tracker (personal)"})
        with urllib.request.urlopen(req, timeout=120) as r:
            gj = json.loads(r.read())
        feats = []
        for f in gj.get("features", []):
            if not f.get("geometry"):
                continue
            g = f["geometry"]
            g["coordinates"] = _round_coords(g["coordinates"])
            props = {k: v for k, v in (f.get("properties") or {}).items() if v not in (None, "")}
            feats.append({"type": "Feature", "geometry": g, "properties": props})
        if not feats:
            print("wind farms: empty response, keeping old file")
            return
        # make sure order is [lon, lat] (Europe: lon -30..45, lat 30..75)
        xs = [_first_xy(f["geometry"]["coordinates"]) for f in feats[:50]]
        if sum(1 for x in xs if x and x[0] > 30 and abs(x[1]) < 30) > len(xs) / 2:
            for f in feats:
                f["geometry"]["coordinates"] = _swap(f["geometry"]["coordinates"])
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"type": "FeatureCollection", "features": feats,
                       "source": "EMODnet Human Activities, CC BY 4.0", "updated_utc": iso(now())},
                      fh, ensure_ascii=False, separators=(",", ":"))
        print(f"wind farms: {len(feats)} polygons saved")
    except Exception as e:
        print("wind farms download failed:", e)


def save_slot(mmsis, pos, static):
    os.makedirs(DATA, exist_ok=True)
    update_windfarms()
    month_file = os.path.join(DATA, f"positions_{now():%Y-%m}.csv")
    new = not os.path.exists(month_file)
    with open(month_file, "a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        if new:
            w.writeheader()
        for m in mmsis:
            if m in pos:
                w.writerow(pos[m])

    latest_path = os.path.join(DATA, "latest.json")
    try:
        with open(latest_path, encoding="utf-8") as f:
            latest = json.load(f)
    except Exception:
        latest = {"vessels": {}}
    lv = latest.setdefault("vessels", {})
    for m in mmsis:
        v = lv.setdefault(m, {})
        v.update(static.get(m, {}))
        if m in pos:
            v.update({k: pos[m][k] for k in FIELDS if k != "mmsi"})

    # weather, once per hour, at each vessel's latest known position
    last_wx = (latest.get("last_weather") or {}).get("utc")
    due = not last_wx or (now() - datetime.fromisoformat(last_wx.replace("Z", "+00:00"))).total_seconds() >= WX_EVERY_MIN * 60
    if due or os.environ.get("FORCE_WEATHER"):
        pts = [(m, lv[m]["lat"], lv[m]["lon"]) for m in mmsis
               if lv.get(m, {}).get("lat") is not None and m in pos]
        wx = fetch_weather(pts)
        if wx:
            wx_file = os.path.join(DATA, f"weather_{now():%Y-%m}.csv")
            new_wx = not os.path.exists(wx_file)
            with open(wx_file, "a", newline="", encoding="utf-8") as f:
                w = csv.DictWriter(f, fieldnames=WX_FIELDS)
                if new_wx:
                    w.writeheader()
                w.writerows(wx)
            for r in wx:
                lv[r["mmsi"]]["weather"] = {k: r[k] for k in WX_FIELDS if k not in ("mmsi", "lat", "lon")}
            latest["last_weather"] = {"utc": iso(now()), "points": len(wx)}
        print(f"weather: {len(wx)} points")

    seen = sum(1 for m in mmsis if lv.get(m, {}).get("lat") is not None)
    latest["last_run"] = {"utc": iso(now()), "received": len(pos), "tracked": len(mmsis), "ever_seen": seen,
                          "missing": [m for m in mmsis if m not in pos]}
    with open(latest_path, "w", encoding="utf-8") as f:
        json.dump(latest, f, indent=1, ensure_ascii=False)
    print(f"[{now():%H:%M}Z] {len(pos)}/{len(mmsis)} vessels this slot, {seen}/{len(mmsis)} seen so far")
    git_save(f"AIS update {now():%Y-%m-%dT%H:%MZ}")


def main():
    if not KEY:
        print("Secret AISSTREAM_API_KEY is missing (Settings > Secrets and variables > Actions).")
        sys.exit(1)
    with open(os.path.join(ROOT, "vessels.json"), encoding="utf-8") as f:
        vessels = json.load(f)
    mmsis = [str(v["mmsi"]) for v in vessels][:50]
    asyncio.run(listen(mmsis, lambda p, s: save_slot(mmsis, p, s)))


if __name__ == "__main__":
    main()
