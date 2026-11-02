#!/usr/bin/env node
/* Vessel Tracker – weekly report.
   Builds an HTML summary of the last REPORT_DAYS days from the repository data (same analysis as the dashboard)
   and e-mails it via Resend (RESEND_API_KEY + REPORT_EMAIL secrets). Without the key it only writes report.html. */
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = __dirname, DATA = path.join(ROOT, "data");
const DAYS = +(process.env.REPORT_DAYS || 7), HOURS = DAYS * 24;

const A = {console};
vm.createContext(A);
vm.runInContext(fs.readFileSync(path.join(ROOT, "analysis.js"), "utf8"), A);
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };
const readText = f => { try { return fs.readFileSync(f, "utf8"); } catch (e) { return null; } };

// ---------- load data ----------
const vessels = readJSON(path.join(ROOT, "vessels.json"), []);
const latest = readJSON(path.join(DATA, "latest.json"), {vessels: {}});
const disc0 = readJSON(path.join(DATA, "discovery.json"), {vessels: {}});
A.LIMIT_OVERRIDE = readJSON(path.join(ROOT, "limits.json"), {});
const gj = readJSON(path.join(DATA, "windfarms.geojson"), null);
if (gj) A.buildWfIndex(gj);
const now = new Date();
for (let i = 1; i >= 0; i--) {
  const m = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7);
  const p = readText(path.join(DATA, `positions_${m}.csv`)); if (p) A.loadPositions(A.parseCSV(p));
  const w = readText(path.join(DATA, `weather_${m}.csv`)); if (w) A.loadWeather(A.parseCSV(w));
  const dp = readText(path.join(DATA, `dma_positions_${m}.csv`)); if (dp) A.loadPositions(A.parseCSV(dp));
}
A.sortAll();
const disc = A.mergeDiscovery(disc0, readJSON(path.join(DATA, "dma_discovery.json"), {vessels: {}}));

// ---------- analysis ----------
const list = vessels.map(v => ({mmsi: String(v.mmsi), label: v.name || v.mmsi, contractor: v.contractor || "", vtype: v.type || ""}));
const rows = list.map(v => ({v, r: A.vuo(v.mmsi, HOURS, v.vtype)}));
const sites = A.siteSummary(list, HOURS);
const sum = (a, keys) => keys.reduce((s, k) => s + (a.totals[k] || 0), 0);
const pct = (h) => h > 0.05 ? (100 * h / HOURS).toFixed(0) + "%" : "–";
const f1 = x => x == null || isNaN(x) ? "–" : (+x).toFixed(1);
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
const dstr = t => new Date(t).toLocaleString("en-GB", {timeZone: "Europe/Berlin", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit"});
const start = new Date(Date.now() - HOURS * 3600e3);

const covered = rows.filter(x => sum(x.r.a, ["No data"]) < HOURS - 0.5);
const neverSeen = rows.filter(x => !covered.includes(x));
const fleetWork = covered.reduce((s, x) => s + sum(x.r.a, A.WORK_STATES), 0);
const fleetWow = covered.reduce((s, x) => s + sum(x.r.a, ["Waiting on weather"]), 0);
const installs = rows.filter(x => !A.isCLV(x.v.vtype)).reduce((s, x) => s + x.r.site.length, 0);
const km = rows.filter(x => A.isCLV(x.v.vtype)).reduce((s, x) => s + x.r.lay.reduce((t, l) => t + l.km, 0), 0);
const portCount = {};
rows.forEach(x => x.r.calls.forEach(c => { portCount[c.port] = (portCount[c.port] || 0) + 1; }));
const AISTYPE = (t, txt) => { t = +t; if (!t) return txt || "Unknown"; if (t === 30) return "Fishing"; if (t === 31 || t === 32) return "Towing"; if (t === 33) return "Dredging / UW ops";
  if (t === 52) return "Tug"; if (t >= 60 && t < 70) return "Passenger"; if (t >= 70 && t < 80) return "Cargo"; if (t >= 80 && t < 90) return "Tanker";
  if (t >= 90 && t < 100) return "Other (SOV/CTV/special)"; return "Type " + t; };
const tracked = new Set(list.map(v => v.mmsi));
const discTop = Object.entries(disc.vessels || {}).map(([m, d]) => ({mmsi: m, ...d}))
  .filter(d => !tracked.has(d.mmsi) && !(+d.ship_type >= 70 && +d.ship_type < 90) && !/cargo|tanker/i.test(d.ship_type_txt || "") && (d.slots || 0) >= 4)
  .sort((a, b) => (b.slots || 0) - (a.slots || 0)).slice(0, 12);
const repo = process.env.GITHUB_REPOSITORY || "";
const dash = repo ? `https://${repo.split("/")[0]}.github.io/${repo.split("/")[1]}/` : "";

// ---------- HTML (inline styles for e-mail clients) ----------
const TH = 'style="text-align:left;padding:5px 8px;border-bottom:2px solid #d0d7de;font-size:12px;color:#57606a;white-space:nowrap"';
const THR = TH.replace("text-align:left", "text-align:right");
const TD = 'style="padding:5px 8px;border-bottom:1px solid #eaeef2;font-size:13px;white-space:nowrap"';
const TDR = TD.replace("padding", "text-align:right;padding");
const table = (head, body) => `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;margin:6px 0 18px">${head}${body}</table>`;
const h2 = t => `<h2 style="font-size:16px;margin:22px 0 4px;color:#0b3d5c">${t}</h2>`;
const note = t => `<p style="font-size:12px;color:#57606a;margin:0 0 6px">${t}</p>`;
const kpi = (label, val) => `<td style="padding:10px 14px;background:#f6f8fa;border-radius:6px;text-align:center"><div style="font-size:20px;font-weight:700;color:#0b3d5c">${val}</div><div style="font-size:11px;color:#57606a">${label}</div></td><td style="width:8px"></td>`;

let html = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:900px;color:#1f2328">
<h1 style="font-size:20px;margin:0 0 2px;color:#0b3d5c">⚓ Vessel Tracker – weekly report</h1>
<p style="margin:0 0 14px;color:#57606a;font-size:13px">${dstr(start)} – ${dstr(Date.now())} (Berlin time) · ${list.length} tracked vessels${dash ? ` · <a href="${dash}">Open dashboard</a>` : ""}</p>
<table cellspacing="0" cellpadding="0"><tr>
${kpi("vessels with data", `${covered.length}/${list.length}`)}${kpi("working hours", fleetWork.toFixed(0))}${kpi("waiting on weather h", fleetWow.toFixed(0))}${kpi("installations (est.)", installs)}${kpi("cable km (est.)", km.toFixed(1))}
</tr></table>`;

// highlights
const busiest = covered.map(x => ({v: x.v, w: sum(x.r.a, A.WORK_STATES)})).sort((a, b) => b.w - a.w).slice(0, 5);
html += h2("Highlights");
html += `<ul style="font-size:13px;margin:4px 0 0 18px;padding:0">
${busiest.map(b => `<li><b>${esc(b.v.label)}</b> (${esc(b.v.contractor)}) – ${b.w.toFixed(0)} h working</li>`).join("")}
${sites[0] ? `<li>Busiest wind farm: <b>${esc(sites[0].name)}</b> – ${sites[0].vesselList.length} vessels, ${sites[0].hours.toFixed(0)} vessel-hours, ${sites[0].wow.toFixed(0)} h waiting on weather</li>` : ""}
${Object.keys(portCount).length ? `<li>Most visited port: <b>${esc(Object.entries(portCount).sort((a, b) => b[1] - a[1])[0][0])}</b></li>` : ""}
</ul>`;

// fleet table
html += h2("Fleet utilisation (VUO)");
html += note("Share of the week. Work = stationary/slow at work incl. same-spot AIS gaps in wind farms; WoW = working position with Hs/wind above the vessel-type limit.");
html += table(`<tr><th ${TH}>Vessel</th><th ${TH}>Contractor</th><th ${TH}>Type</th><th ${THR}>Work</th><th ${THR}>WoW</th><th ${THR}>Transit</th><th ${THR}>Port</th><th ${THR}>No data</th><th ${THR}>Installs</th><th ${THR}>Cable km</th><th ${TH}>Main wind farm</th></tr>`,
  covered.sort((a, b) => sum(b.r.a, A.WORK_STATES) - sum(a.r.a, A.WORK_STATES)).map(({v, r}) => {
    const clv = A.isCLV(v.vtype), k = r.lay.reduce((s, l) => s + l.km, 0);
    return `<tr><td ${TD}><b>${esc(v.label)}</b></td><td ${TD}>${esc(v.contractor)}</td><td ${TD}>${esc(v.vtype)}</td>
      <td ${TDR}>${pct(sum(r.a, A.WORK_STATES))}</td><td ${TDR}>${pct(sum(r.a, ["Waiting on weather"]))}</td><td ${TDR}>${pct(sum(r.a, ["Transit", "Transit (est.)"]))}</td>
      <td ${TDR}>${pct(sum(r.a, ["Moored"]))}</td><td ${TDR}>${pct(sum(r.a, ["No data"]))}</td>
      <td ${TDR}>${clv ? "–" : (r.site.length || "–")}</td><td ${TDR}>${clv && k ? k.toFixed(1) : "–"}</td><td ${TD}>${esc(r.wfs[0] || "–")}</td></tr>`;
  }).join(""));

// job log: wind farm visits per vessel
const visits = [];
list.forEach(v => { const J = A.jobLog(v.mmsi, HOURS, v.vtype); J.visits.forEach(x => visits.push({v, x, clv: J.clv})); });
if (visits.length) {
  html += h2("Wind farm visits (job log)");
  html += note("One row per vessel visit to a wind farm. Positions = stationary jobs ≥ 2 h at separate spots; net h = position time minus weather time. Full detail per position / lay run in the attached Jobs CSV and in the dashboard (VUO → click vessel).");
  html += table(`<tr><th ${TH}>Vessel</th><th ${TH}>Wind farm</th><th ${TH}>Arrived</th><th ${TH}>Left</th><th ${THR}>On site h</th><th ${THR}>Positions / runs</th><th ${THR}>h / position</th><th ${THR}>net h / pos.</th><th ${THR}>km</th><th ${THR}>Weather h</th></tr>`,
    visits.sort((a, b) => b.x.start - a.x.start).slice(0, 40).map(({v, x, clv}) => `<tr><td ${TD}><b>${esc(v.label)}</b></td><td ${TD}>${esc(x.wf)}</td><td ${TD}>${dstr(x.start)}</td><td ${TD}>${x.ongoing ? "ongoing" : dstr(x.end)}</td>
      <td ${TDR}>${f1(x.h)}</td><td ${TDR}>${x.jobs}</td><td ${TDR}>${clv ? "–" : f1(x.avgJobH)}</td><td ${TDR}>${clv ? "–" : f1(x.netJobH)}</td><td ${TDR}>${clv ? f1(x.km) : "–"}</td><td ${TDR}>${f1(x.wowH)}</td></tr>`).join(""));
}

// sites
html += h2("Wind farm activity");
html += sites.length ? table(`<tr><th ${TH}>Wind farm</th><th ${TH}>Status</th><th ${THR}>Vessels</th><th ${THR}>Vessel-h</th><th ${THR}>Working h</th><th ${THR}>WoW h</th><th ${THR}>Installs</th><th ${THR}>Cable km</th><th ${TH}>Vessels on site</th></tr>`,
  sites.slice(0, 20).map(s => `<tr><td ${TD}><b>${esc(s.name)}</b></td><td ${TD}>${esc(s.status)}</td><td ${TDR}>${s.vesselList.length}</td><td ${TDR}>${s.hours.toFixed(0)}</td><td ${TDR}>${s.work.toFixed(0)}</td><td ${TDR}>${s.wow.toFixed(0)}</td>
    <td ${TDR}>${s.installs ? s.installs + (s.turbines ? ` / ${s.turbines}` : "") : "–"}</td><td ${TDR}>${s.km ? s.km.toFixed(1) : "–"}</td>
    <td ${TD} style="white-space:normal;padding:5px 8px;border-bottom:1px solid #eaeef2;font-size:12px">${esc(s.vesselList.map(V => V.v.label).join(", "))}</td></tr>`).join(""))
  : note("No tracked vessel time inside wind farms this week.");

// port calls
if (Object.keys(portCount).length) {
  html += h2("Port calls");
  html += table(`<tr><th ${TH}>Vessel</th><th ${TH}>Port</th><th ${TH}>Arrived</th><th ${THR}>Hours</th></tr>`,
    rows.flatMap(x => x.r.calls.map(c => ({v: x.v, c}))).sort((a, b) => b.c.start - a.c.start).slice(0, 25)
      .map(({v, c}) => `<tr><td ${TD}>${esc(v.label)}</td><td ${TD}>${esc(c.port)}</td><td ${TD}>${dstr(c.start)}</td><td ${TDR}>${f1(c.h)}</td></tr>`).join(""));
}

// discovery
if (discTop.length) {
  html += h2("Discovered vessels in wind farms (not tracked)");
  html += table(`<tr><th ${TH}>Name</th><th ${TH}>MMSI</th><th ${TH}>AIS type</th><th ${THR}>Hours seen</th><th ${TH}>Wind farm(s)</th></tr>`,
    discTop.map(d => `<tr><td ${TD}>${esc(d.name || "–")}</td><td ${TD}>${d.mmsi}</td><td ${TD}>${AISTYPE(d.ship_type, d.ship_type_txt)}</td><td ${TDR}>${((d.slots || 0) / 4).toFixed(1)}</td><td ${TD}>${esc((d.sites || []).slice(0, 3).join(", "))}</td></tr>`).join(""));
}

if (neverSeen.length) html += note(`<b>No AIS data this week:</b> ${esc(neverSeen.map(x => x.v.label).join(", "))}.`);
html += `<p style="font-size:11px;color:#8c959f;margin-top:20px">Estimates from free terrestrial AIS (AISStream.io; Norwegian waters: BarentsWatch / Norwegian Coastal Administration, NLOD), Open-Meteo weather and EMODnet wind farm data (CC BY 4.0). Typical accuracy ±10–20%. Personal, non-commercial use.</p></div>`;

// ---------- activity CSV attachment ----------
const csv = [["mmsi", "vessel", "contractor", "type", "activity", "start_utc", "end_utc", "hours", "wind_farm", "port", "hs_avg_m", "wind_avg_ms"].join(";")];
list.forEach(v => A.activity(v.mmsi, HOURS, v.vtype).segs.forEach(s => {
  if (s.state === "No data") return;
  csv.push([v.mmsi, v.label, v.contractor, v.vtype, s.state, new Date(s.start).toISOString(), new Date(s.end).toISOString(),
    s.hours.toFixed(2), s.wf || "", s.port || "", s.hs == null ? "" : s.hs.toFixed(2), s.wind == null ? "" : s.wind.toFixed(1)].join(";"));
}));
const csvText = "﻿" + csv.join("\n");
const jobs = [["mmsi", "vessel", "contractor", "type", "wind_farm", "visit_no", "item_no", "activity", "start_utc", "end_utc", "hours", "km", "pause_reason", "weather_h_inside", "hs_avg_m", "lat", "lon"].join(";")];
list.forEach(v => A.jobLog(v.mmsi, HOURS, v.vtype).visits.forEach((x, i) => { let n = 0; x.items.forEach(it => { const p = it.kind === "Pause"; if (!p) n++;
  jobs.push([v.mmsi, v.label, v.contractor, v.vtype, x.wf, i + 1, p ? "" : n, p ? "Pause" : it.kind, new Date(it.start).toISOString(), new Date(it.end).toISOString(), it.h.toFixed(2),
    !p && it.km != null ? it.km.toFixed(2) : "", p ? it.reason : "", !p && it.wowH ? it.wowH.toFixed(2) : "", it.hs != null ? it.hs.toFixed(2) : "", it.lat != null ? it.lat.toFixed(5) : "", it.lon != null ? it.lon.toFixed(5) : ""].join(";")); }); }));
const jobsText = "\ufeff" + jobs.join("\n");
fs.writeFileSync(path.join(ROOT, "report.html"), html);
fs.writeFileSync(path.join(ROOT, "report_activity.csv"), csvText);
fs.writeFileSync(path.join(ROOT, "report_jobs.csv"), jobsText);
console.log(`report: ${covered.length}/${list.length} vessels with data, ${sites.length} wind farms, ${installs} installs, ${km.toFixed(1)} km`);

// ---------- send ----------
(async () => {
  const key = process.env.RESEND_API_KEY, to = process.env.REPORT_EMAIL;
  if (!key || !to) { console.log("RESEND_API_KEY or REPORT_EMAIL not set – report.html written, no e-mail sent."); return; }
  const week = `${start.toISOString().slice(0, 10)} – ${now.toISOString().slice(0, 10)}`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {"Authorization": `Bearer ${key}`, "Content-Type": "application/json"},
    body: JSON.stringify({
      from: process.env.REPORT_FROM || "Vessel Tracker <onboarding@resend.dev>",
      to: [to], subject: `Vessel Tracker – weekly report ${week}`, html,
      attachments: [{filename: `vessel_activity_${now.toISOString().slice(0, 10)}.csv`, content: Buffer.from(csvText).toString("base64")},
                    {filename: `vessel_jobs_${now.toISOString().slice(0, 10)}.csv`, content: Buffer.from(jobsText).toString("base64")}]
    })
  });
  const txt = await res.text();
  console.log("Resend:", res.status, txt.slice(0, 300));
  if (!res.ok) process.exit(1);
})();
