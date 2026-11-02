/* Vessel Tracker – shared analysis (used by index.html in the browser and report.js in Node).
   Globals (set by the caller): positions {mmsi:[{ts,lat,lon,sog,cog,nav}]}, weather {mmsi:[{ts,wind,gust,hs,tp}]},
   wfIndex (built with buildWfIndex), LIMIT_OVERRIDE (optional, from limits.json), NOW() for "current time". */
var positions = {}, weather = {}, wfIndex = [], LIMIT_OVERRIDE = {};
var NOW = function () { return Date.now(); };

var INTERVAL = 15, GAP = 50, WORK_FILL_MAX_H = 48; // minutes / hours
var STATES = ["Stationary / working", "Working (est.)", "Waiting on weather", "Slow / manoeuvring",
  "Transit", "Transit (est.)", "At anchor", "Moored", "No data"];
var SCOL = {"Stationary / working": "#2fbf71", "Working (est.)": "#8fdcb0", "Waiting on weather": "#e0563f",
  "Slow / manoeuvring": "#9b7be0", "Transit": "#2f9be0", "Transit (est.)": "#7fc3f0", "At anchor": "#e0a92f",
  "Moored": "#8aa0b4", "No data": "#3a4a5c"};
var WORK_STATES = ["Stationary / working", "Working (est.)", "Slow / manoeuvring"];

/* ---------- weather limits per vessel type (editable in limits.json) ---------- */
var DEFAULT_LIMITS = [
  {match: "WTIV", hs: 2.5, wind: 12, note: "jack-up: crane wind limit"},
  {match: "Jack-up", hs: 2.5, wind: 12, note: "jack-up: crane wind limit"},
  {match: "CLV", hs: 2.5, wind: 18, note: "cable lay"},
  {match: "Support", hs: 2.5, wind: 18, note: "support vessel"},
  {match: "", hs: 2.0, wind: 15, note: "HLV / SSCV / crane vessel"}
];
function limitsFor(vtype) {
  var t = String(vtype || "").toLowerCase();
  for (var k in LIMIT_OVERRIDE) if (k && t.indexOf(k.toLowerCase()) >= 0) return LIMIT_OVERRIDE[k];
  for (var i = 0; i < DEFAULT_LIMITS.length; i++) {
    var L = DEFAULT_LIMITS[i];
    if (!L.match || t.indexOf(L.match.toLowerCase()) >= 0) return L;
  }
  return DEFAULT_LIMITS[DEFAULT_LIMITS.length - 1];
}
function wxAt(mmsi, t) {
  var w = weather[mmsi] || [], best = null, bd = 90 * 60e3;
  for (var i = 0; i < w.length; i++) { var d = Math.abs(Date.parse(w[i].ts) - t); if (d <= bd) { bd = d; best = w[i]; } }
  return best;
}
function overLimit(mmsi, t, lim) {
  var w = wxAt(mmsi, t); if (!w || !lim) return false;
  return (w.hs != null && w.hs > lim.hs) || (w.wind != null && w.wind > lim.wind);
}

/* ---------- geometry ---------- */
function hav(a, b) {
  var R = 6371, t = Math.PI / 180, dl = (b.lat - a.lat) * t, dn = (b.lon - a.lon) * t;
  var x = Math.pow(Math.sin(dl / 2), 2) + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.pow(Math.sin(dn / 2), 2);
  return 2 * R * Math.asin(Math.sqrt(x));
}
function pick(p, keys) {
  for (var i = 0; i < keys.length; i++) if (p && p[keys[i]] != null && p[keys[i]] !== "") return p[keys[i]];
  var lk = Object.keys(p || {}).find(function (k) { return keys.some(function (x) { return k.toLowerCase() === x.toLowerCase(); }); });
  return lk ? p[lk] : null;
}
function wfName(p) { return pick(p, ["name", "NAME", "Name", "site_name", "windfarm"]) || "Wind farm"; }
function wfStatus(p) { return String(pick(p, ["status", "STATUS", "Status"]) || "").toLowerCase(); }
function wfTurbines(p) {
  var v = pick(p, ["n_turbines", "N_TURBINES", "turbines", "nturbines", "num_turbines", "no_turbines"]);
  if (v == null) { var k = Object.keys(p || {}).find(function (x) { return /turb/i.test(x) && !isNaN(+p[x]); }); v = k ? p[k] : null; }
  return v == null || isNaN(+v) ? null : +v;
}
function inRing(x, y, r) {
  var c = false;
  for (var i = 0, j = r.length - 1; i < r.length; j = i++) {
    var xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) c = !c;
  }
  return c;
}
function inPoly(x, y, rings) {
  if (!inRing(x, y, rings[0])) return false;
  for (var k = 1; k < rings.length; k++) if (inRing(x, y, rings[k])) return false;
  return true;
}
function buildWfIndex(gj) {
  wfIndex = [];
  (gj.features || []).forEach(function (f) {
    var g = f.geometry; if (!g) return;
    var polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    if (!polys.length) return;
    var b = [180, 90, -180, -90];
    polys.forEach(function (pl) { pl[0].forEach(function (c) { b = [Math.min(b[0], c[0]), Math.min(b[1], c[1]), Math.max(b[2], c[0]), Math.max(b[3], c[1])]; }); });
    wfIndex.push({name: wfName(f.properties), status: wfStatus(f.properties), turbines: wfTurbines(f.properties),
      country: pick(f.properties, ["country", "COUNTRY"]), b: b, polys: polys});
  });
  wfIndex.sort(function (a, b) { return (a.status === "planned") - (b.status === "planned"); }); // prefer built / under construction
}
function windfarmAt(lat, lon) {
  for (var i = 0; i < wfIndex.length; i++) {
    var w = wfIndex[i];
    if (lon < w.b[0] || lon > w.b[2] || lat < w.b[1] || lat > w.b[3]) continue;
    for (var j = 0; j < w.polys.length; j++) if (inPoly(lon, lat, w.polys[j])) return w.name;
  }
  return null;
}
function windfarmInfo(name) { return wfIndex.find(function (w) { return w.name === name; }) || null; }

/* ---------- ports used in offshore wind (approximate centre, 12 km radius) ---------- */
var PORTS = [
  ["Eemshaven", 53.45, 6.83], ["Esbjerg", 55.47, 8.43], ["Vlissingen", 51.45, 3.65], ["Rotterdam Maasvlakte", 51.96, 4.03],
  ["Rotterdam", 51.90, 4.40], ["Cuxhaven", 53.87, 8.70], ["Bremerhaven", 53.56, 8.56], ["Emden", 53.34, 7.19],
  ["Wilhelmshaven", 53.52, 8.15], ["Nordenham", 53.49, 8.48], ["Hamburg", 53.54, 9.93], ["Kiel", 54.33, 10.15],
  ["Rostock", 54.15, 12.10], ["Mukran / Sassnitz", 54.48, 13.60], ["Rønne", 55.10, 14.69], ["Świnoujście", 53.91, 14.26],
  ["Gdańsk", 54.40, 18.67], ["Gdynia", 54.53, 18.55], ["Ostend", 51.24, 2.93], ["Zeebrugge", 51.33, 3.20],
  ["Antwerp", 51.28, 4.30], ["Dunkirk", 51.05, 2.35], ["Le Havre", 49.48, 0.12], ["Cherbourg", 49.65, -1.62],
  ["Brest", 48.38, -4.48], ["Saint-Nazaire", 47.28, -2.20], ["Den Helder", 52.96, 4.78], ["IJmuiden", 52.46, 4.60],
  ["Amsterdam", 52.41, 4.80], ["Harlingen", 53.17, 5.41], ["Hvide Sande", 56.00, 8.13], ["Grenaa", 56.41, 10.92],
  ["Frederikshavn", 57.44, 10.55], ["Hirtshals", 57.59, 9.96], ["Lindø / Odense", 55.47, 10.53], ["Aalborg", 57.05, 9.92],
  ["Gothenburg", 57.69, 11.90], ["Hull", 53.74, -0.28], ["Grimsby", 53.58, -0.07], ["Great Yarmouth", 52.57, 1.73],
  ["Lowestoft", 52.47, 1.75], ["Harwich", 51.95, 1.28], ["Tyne", 55.00, -1.45], ["Blyth", 55.12, -1.50],
  ["Teesport", 54.60, -1.16], ["Montrose", 56.71, -2.46], ["Aberdeen", 57.14, -2.08], ["Peterhead", 57.50, -1.78],
  ["Nigg / Invergordon", 57.69, -4.08], ["Ardersier", 57.57, -4.03], ["Leith", 55.98, -3.18], ["Rosyth", 56.02, -3.44],
  ["Methil", 56.18, -3.00], ["Dundee", 56.46, -2.95], ["Belfast", 54.62, -5.89], ["Barrow", 54.10, -3.23],
  ["Mostyn", 53.32, -3.27], ["Liverpool", 53.45, -3.02], ["Swansea", 51.61, -3.92], ["Milford Haven", 51.71, -5.05],
  ["Cork", 51.85, -8.30], ["Bergen / Ågotnes", 60.40, 5.15], ["Stavanger", 58.97, 5.73], ["Haugesund", 59.41, 5.27],
  ["Kristiansand", 58.14, 8.00], ["Ferrol", 43.48, -8.23], ["Bilbao", 43.35, -3.05], ["Cádiz", 36.53, -6.29],
  ["Fos-sur-Mer", 43.43, 4.87], ["Taranto", 40.47, 17.21], ["New Bedford", 41.63, -70.92], ["New London", 41.35, -72.09],
  ["Portsmouth VA", 36.84, -76.30], ["Baltimore", 39.26, -76.58], ["Taichung", 24.29, 120.51], ["Kaohsiung", 22.60, 120.28],
  ["Busan", 35.10, 129.04], ["Ulsan", 35.50, 129.38], ["Singapore", 1.27, 103.80], ["Batam", 1.08, 104.03],
  ["Shanghai", 31.23, 121.49], ["Nantong / Qidong", 31.90, 121.30], ["Zhoushan", 30.00, 122.10], ["Yantai", 37.55, 121.38]
];
function portAt(lat, lon) {
  var best = null, bd = 12;
  for (var i = 0; i < PORTS.length; i++) { var d = hav({lat: lat, lon: lon}, {lat: PORTS[i][1], lon: PORTS[i][2]}); if (d < bd) { bd = d; best = PORTS[i][0]; } }
  return best;
}

/* ---------- activity ---------- */
function classify(sog, nav) {
  if (nav === 5) return "Moored"; if (nav === 1) return "At anchor";
  if (sog == null) return nav === 0 ? "Transit" : "Stationary / working";
  if (sog < 1) return "Stationary / working"; if (sog < 5) return "Slow / manoeuvring"; return "Transit";
}
function isWorking(s) { return s === "Stationary / working" || s === "Slow / manoeuvring"; }
// What happened during an AIS gap? Same spot before and after -> the vessel stayed there.
function gapFill(p, q, st, km, kn, dt) {
  if (!q) return "No data";
  var stQ = classify(q.sog, q.nav);
  if (km < 1 && dt <= WORK_FILL_MAX_H * 3600e3) {
    if (isWorking(st) && isWorking(stQ) && (!wfIndex.length || windfarmAt(p.lat, p.lon))) return "Working (est.)";
    if (st === stQ && (st === "Moored" || st === "At anchor")) return st;
  }
  if (km > 5 && kn >= 3) return "Transit (est.)";
  return "No data";
}
function activity(mmsi, hours, vtype) {
  var end = NOW(), start = end - hours * 3600e3, lim = limitsFor(vtype);
  var pts = (positions[mmsi] || []).filter(function (p) { return Date.parse(p.ts) >= start; });
  var segs = [];
  function push(state, t0, t1, p, anchor) {
    if (t1 <= t0) return;
    var l = segs[segs.length - 1];
    if (l && l.state === state) { l.end = t1; if (p) l.pts.push(p); }
    else segs.push({state: state, start: t0, end: t1, pts: p ? [p] : [], anchor: anchor || p || null});
  }
  // weather check only for real working states offshore
  function wow(st, t) { return st === "Stationary / working" && overLimit(mmsi, t, lim) ? "Waiting on weather" : st; }
  if (pts.length) push("No data", start, Date.parse(pts[0].ts), null); else push("No data", start, end, null);
  pts.forEach(function (p, i) {
    var t = Date.parse(p.ts), tn = i + 1 < pts.length ? Date.parse(pts[i + 1].ts) : Math.min(end, t + INTERVAL * 60e3);
    var st = classify(p.sog, p.nav), stw = wow(st, t);
    if (tn - t > GAP * 60e3) {
      push(stw, t, t + INTERVAL * 60e3, p);
      var q = i + 1 < pts.length ? pts[i + 1] : null, km = q ? hav(p, q) : 0, kn = q ? (km / 1.852) / ((tn - t) / 3600e3) : 0;
      var g = gapFill(p, q, st, km, kn, tn - t), t0 = t + INTERVAL * 60e3;
      if (g === "Working (est.)") {
        // split the gap hour by hour into working / waiting on weather
        for (var h = t0; h < tn; h += 3600e3) push(overLimit(mmsi, h, lim) ? "Waiting on weather" : g, h, Math.min(tn, h + 3600e3), null, p);
      } else push(g, t0, tn, null, p);
    } else push(stw, t, tn, p);
  });
  if (pts.length) { var lt = Date.parse(pts[pts.length - 1].ts) + INTERVAL * 60e3; if (lt < end) push("No data", lt, end, null); }
  var wx = weather[mmsi] || [], totals = {};
  STATES.forEach(function (s) { totals[s] = 0; });
  segs.forEach(function (s) {
    s.hours = (s.end - s.start) / 3600e3; totals[s.state] += s.hours;
    if (s.pts.length) {
      s.lat = s.pts.reduce(function (a, p) { return a + p.lat; }, 0) / s.pts.length;
      s.lon = s.pts.reduce(function (a, p) { return a + p.lon; }, 0) / s.pts.length;
      var sg = s.pts.filter(function (p) { return p.sog != null; });
      s.avg_sog = sg.length ? sg.reduce(function (a, p) { return a + p.sog; }, 0) / sg.length : null;
    } else if (s.anchor && s.state !== "Transit (est.)" && s.state !== "No data") { s.lat = s.anchor.lat; s.lon = s.anchor.lon; }
    if (s.lat != null) {
      s.wf = windfarmAt(s.lat, s.lon);
      if (s.state === "Moored" || s.state === "At anchor" || !s.wf) s.port = portAt(s.lat, s.lon);
    }
    var w = wx.filter(function (x) { var t = Date.parse(x.ts); return t >= s.start - 30 * 60e3 && t < s.end; });
    function vals(k) { return w.map(function (x) { return x[k]; }).filter(function (x) { return x != null; }); }
    function avg(k) { var v = vals(k); return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : null; }
    function mx(k) { var v = vals(k); return v.length ? Math.max.apply(null, v) : null; }
    s.hs = avg("hs"); s.hs_max = mx("hs"); s.wind = avg("wind"); s.wind_max = mx("wind");
  });
  return {segs: segs, totals: totals, limits: lim};
}

/* ---------- VUO: installations, cable lay, port calls ---------- */
function isCLV(vtype) { return /CLV|cable/i.test(vtype || ""); }
function vuo(mmsi, hours, vtype) {
  var start = NOW() - hours * 3600e3;
  var pts = (positions[mmsi] || []).filter(function (p) { return Date.parse(p.ts) >= start; });
  var wx = weather[mmsi] || [];
  function hsAt(t0, t1) {
    var v = wx.filter(function (x) { var t = Date.parse(x.ts); return t >= t0 - 30 * 60e3 && t <= t1; }).map(function (x) { return x.hs; }).filter(function (x) { return x != null; });
    return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : null;
  }
  function still(p) { return p.nav !== 5 && p.nav !== 1 && (p.sog != null ? p.sog < 1 : p.nav !== 0); }
  // stops = stationary at one spot offshore (installation positions / pull-ins)
  var stops = [], cur = null;
  pts.forEach(function (p) {
    if (still(p) && cur && hav(cur.c, p) < 0.3 && Date.parse(p.ts) - cur.last < 12 * 3600e3) { cur.last = Date.parse(p.ts); return; }
    if (cur) { stops.push(cur); cur = null; }
    if (still(p)) cur = {c: {lat: p.lat, lon: p.lon}, first: Date.parse(p.ts), last: Date.parse(p.ts)};
  });
  if (cur) stops.push(cur);
  var st = stops.map(function (s) { return {lat: s.c.lat, lon: s.c.lon, start: s.first, end: s.last + INTERVAL * 60e3, h: (s.last - s.first) / 3600e3 + INTERVAL / 60}; })
    .filter(function (s) { return s.h >= 2 && s.h <= 96; });
  var merged = [];
  st.forEach(function (s) { var l = merged[merged.length - 1]; if (l && hav(l, s) < 0.5) { l.end = s.end; l.h += s.h; } else merged.push(Object.assign({}, s)); });
  merged.forEach(function (s) { s.wf = windfarmAt(s.lat, s.lon); s.hs = hsAt(s.start, s.end); });
  var haveWF = wfIndex.length > 0, site = merged.filter(function (s) { return !haveWF || s.wf; });
  // lay = slow continuous progress (cable lay / trenching)
  var lays = [], L0 = null;
  pts.forEach(function (p, i) {
    var slow = p.nav !== 5 && p.nav !== 1 && p.sog != null && p.sog >= 0.05 && p.sog < 1.5, prev = pts[i - 1];
    var cont = L0 && prev && Date.parse(p.ts) - Date.parse(prev.ts) <= GAP * 60e3;
    if (slow && cont) { L0.km += hav(prev, p); L0.end = Date.parse(p.ts); L0.pts.push(p); }
    else { if (L0) lays.push(L0); L0 = slow ? {start: Date.parse(p.ts), end: Date.parse(p.ts), km: 0, pts: [p]} : null; }
  });
  if (L0) lays.push(L0);
  var lay = lays.map(function (l) {
    var m = l.pts[Math.floor(l.pts.length / 2)];
    return {start: l.start, end: l.end + INTERVAL * 60e3, h: (l.end - l.start) / 3600e3 + INTERVAL / 60, km: l.km, lat: m.lat, lon: m.lon, wf: windfarmAt(m.lat, m.lon), hs: hsAt(l.start, l.end)};
  }).filter(function (l) { return l.km >= 0.5 && l.h >= 1; });
  var a = activity(mmsi, hours, vtype);
  var calls = a.segs.filter(function (s) { return s.state === "Moored" && s.hours >= 2; })
    .map(function (s) { return {port: s.port || "Unknown port", start: s.start, end: s.end, h: s.hours}; });
  var wfs = {};
  site.concat(lay).forEach(function (s) { if (s.wf) wfs[s.wf] = (wfs[s.wf] || 0) + s.h; });
  return {a: a, site: site, stops: merged, lay: lay, portCalls: calls.length, calls: calls,
    wfs: Object.entries(wfs).sort(function (x, y) { return y[1] - x[1]; }).map(function (x) { return x[0]; })};
}

/* ---------- Job log: wind farm visits -> positions / lay segments -> pauses ---------- */
// What the vessel mostly did during [t0,t1] according to the activity segments
function dominantState(a, t0, t1) {
  var hrs = {};
  a.segs.forEach(function (s) {
    var o = Math.min(s.end, t1) - Math.max(s.start, t0);
    if (o > 0) hrs[s.state] = (hrs[s.state] || 0) + o / 3600e3;
  });
  var best = null, bh = 0;
  Object.keys(hrs).forEach(function (k) { if (hrs[k] > bh) { bh = hrs[k]; best = k; } });
  return {state: best, hours: hrs};
}
function pauseReason(a, t0, t1, isClv) {
  var d = dominantState(a, t0, t1), h = d.hours, tot = (t1 - t0) / 3600e3;
  if ((h["Waiting on weather"] || 0) >= 0.4 * tot) return "Weather";
  if ((h["Moored"] || 0) >= 0.4 * tot) return "Port";
  if ((h["At anchor"] || 0) >= 0.4 * tot) return "Anchor";
  if ((h["Transit"] || 0) + (h["Transit (est.)"] || 0) >= 0.4 * tot) return "Transit";
  if ((h["No data"] || 0) >= 0.5 * tot) return "No AIS";
  return isClv ? "Stopped (pull-in / jointing / other)" : "Moving / preparing";
}
function jobLog(mmsi, hours, vtype) {
  var r = vuo(mmsi, hours, vtype), clv = isCLV(vtype), a = r.a, items = [];
  if (clv) {
    r.lay.forEach(function (l) { items.push({kind: "Lay / trench", start: l.start, end: l.end, h: l.h, km: l.km, lat: l.lat, lon: l.lon, wf: l.wf, hs: l.hs}); });
    // stationary stops inside wind farms between lay runs = pull-in, jointing, hold
    r.stops.filter(function (s) { return s.wf; }).forEach(function (s) {
      var overlaps = items.some(function (x) { return s.start < x.end && s.end > x.start; });
      if (!overlaps) items.push({kind: "Stationary on site", start: s.start, end: s.end, h: s.h, km: 0, lat: s.lat, lon: s.lon, wf: s.wf, hs: s.hs});
    });
  } else {
    r.site.forEach(function (s) { items.push({kind: "Position", start: s.start, end: s.end, h: s.h, lat: s.lat, lon: s.lon, wf: s.wf, hs: s.hs}); });
  }
  items.sort(function (x, y) { return x.start - y.start; });
  items.forEach(function (it) { it.wowH = dominantState(a, it.start, it.end).hours["Waiting on weather"] || 0; it.netH = Math.max(0, it.h - it.wowH); });
  // group into visits: same wind farm, gaps < 24 h
  var visits = [], V = null;
  items.forEach(function (it) {
    var key = it.wf || "Outside wind farms";
    if (V && V.wf === key && it.start - V.end < 24 * 3600e3) {
      var gap = (it.start - V.end) / 3600e3;
      if (gap >= 0.25) V.items.push({kind: "Pause", start: V.end, end: it.start, h: gap, reason: pauseReason(a, V.end, it.start, clv)});
      V.items.push(it); V.end = Math.max(V.end, it.end);
    } else {
      V = {wf: key, start: it.start, end: it.end, items: [it]}; visits.push(V);
    }
  });
  visits.forEach(function (v, i) {
    var w = v.items.filter(function (x) { return x.kind !== "Pause"; }), p = v.items.filter(function (x) { return x.kind === "Pause"; });
    v.h = (v.end - v.start) / 3600e3;
    v.jobs = w.length; v.workH = w.reduce(function (s, x) { return s + x.h; }, 0);
    v.km = w.reduce(function (s, x) { return s + (x.km || 0); }, 0);
    v.pauseH = p.reduce(function (s, x) { return s + x.h; }, 0);
    v.wowH = p.filter(function (x) { return x.reason === "Weather"; }).reduce(function (s, x) { return s + x.h; }, 0)
      + w.reduce(function (s, x) { return s + (x.wowH || 0); }, 0);
    v.netJobH = w.length ? w.reduce(function (s, x) { return s + x.netH; }, 0) / w.length : null;
    v.avgJobH = w.length ? v.workH / w.length : null;
    // what happened before arriving and after leaving
    v.arrivedFrom = arrivalContext(a, v.start, -1);
    v.leftTo = arrivalContext(a, v.end, +1);
    v.ongoing = NOW() - v.end < 2 * 3600e3;
  });
  return {visits: visits, calls: r.calls, clv: clv};
}
// nearest port/transit before (dir=-1) or after (dir=+1) a time
function arrivalContext(a, t, dir) {
  var segs = a.segs.filter(function (s) { return dir < 0 ? s.end <= t + 60e3 : s.start >= t - 60e3; });
  if (dir < 0) segs.reverse();
  for (var i = 0; i < Math.min(segs.length, 6); i++) {
    var s = segs[i];
    if (s.state === "Moored" && s.port) return s.port;
    if (s.state === "Moored" || s.state === "At anchor") return s.port || s.state;
  }
  return "";
}

/* ---------- Sites: per wind farm summary across vessels ---------- */
// list: [{mmsi,label,contractor,vtype}]
function siteSummary(list, hours) {
  var sites = {};
  list.forEach(function (v) {
    var r = vuo(v.mmsi, hours, v.vtype), clv = isCLV(v.vtype);
    r.a.segs.forEach(function (s) {
      if (!s.wf) return;
      var S = sites[s.wf] || (sites[s.wf] = {name: s.wf, vessels: {}, hours: 0, work: 0, wow: 0, installs: 0, km: 0, last: 0});
      var V = S.vessels[v.mmsi] || (S.vessels[v.mmsi] = {v: v, segs: [], hours: 0, installs: 0, km: 0});
      V.segs.push(s); V.hours += s.hours; S.hours += s.hours; S.last = Math.max(S.last, s.end);
      if (WORK_STATES.indexOf(s.state) >= 0) S.work += s.hours;
      if (s.state === "Waiting on weather") S.wow += s.hours;
    });
    if (!clv) r.site.forEach(function (x) { if (x.wf && sites[x.wf] && sites[x.wf].vessels[v.mmsi]) { sites[x.wf].installs++; sites[x.wf].vessels[v.mmsi].installs++; } });
    else r.lay.forEach(function (x) { if (x.wf && sites[x.wf] && sites[x.wf].vessels[v.mmsi]) { sites[x.wf].km += x.km; sites[x.wf].vessels[v.mmsi].km += x.km; } });
  });
  return Object.values(sites).map(function (S) {
    var info = windfarmInfo(S.name) || {};
    S.turbines = info.turbines || null; S.status = info.status || ""; S.country = info.country || "";
    S.vesselList = Object.values(S.vessels).sort(function (a, b) { return b.hours - a.hours; });
    return S;
  }).sort(function (a, b) { return b.hours - a.hours; });
}

/* ---------- CSV ---------- */
function parseCSV(txt) {
  var lines = txt.trim().split(/\r?\n/), h = lines.shift().split(",");
  return lines.map(function (l) { var c = l.split(","), o = {}; h.forEach(function (k, i) { o[k] = c[i] === "" ? null : c[i]; }); return o; });
}
function loadPositions(rows) {
  rows.forEach(function (r) {
    (positions[r.mmsi] = positions[r.mmsi] || []).push({ts: r.ts_utc, lat: +r.lat, lon: +r.lon,
      sog: r.sog == null ? null : +r.sog, cog: r.cog == null ? null : +r.cog, nav: r.nav_status == null ? null : +r.nav_status});
  });
}
function loadWeather(rows) {
  function n(x) { return x == null ? null : +x; }
  rows.forEach(function (r) {
    (weather[r.mmsi] = weather[r.mmsi] || []).push({ts: r.ts_utc, wind: n(r.wind_ms), gust: n(r.gust_ms), hs: n(r.hs_m), tp: n(r.tp_s)});
  });
}
function sortAll() {
  for (var k in positions) {
    positions[k].sort(function (a, b) { return a.ts < b.ts ? -1 : 1; });
    var seen = {}, out = [];   // one point per 15-min slot (live AIS and DMA backfill can overlap)
    positions[k].forEach(function (p) { var s = Math.floor(Date.parse(p.ts) / 900e3); if (!seen[s]) { seen[s] = 1; out.push(p); } });
    positions[k] = out;
  }
  for (var w in weather) weather[w].sort(function (a, b) { return a.ts < b.ts ? -1 : 1; });
}
function resetData() { positions = {}; weather = {}; }
function mergeDiscovery(a, b) {   // live discovery + DMA discovery
  var V = Object.assign({}, (a && a.vessels) || {});
  Object.entries((b && b.vessels) || {}).forEach(function (e) {
    var m = e[0], d = e[1], v = V[m];
    if (!v) { V[m] = d; return; }
    V[m] = Object.assign({}, d, v, {slots: (v.slots || 0) + (d.slots || 0),
      sites: Array.from(new Set((v.sites || []).concat(d.sites || []))).slice(0, 5),
      first: [v.first, d.first].filter(Boolean).sort()[0], last: [v.last, d.last].filter(Boolean).sort().pop()});
  });
  return {vessels: V, updated_utc: (a && a.updated_utc) || (b && b.updated_utc)};
}

if (typeof module !== "undefined") module.exports = {}; // loaded via vm in Node (report.js)
