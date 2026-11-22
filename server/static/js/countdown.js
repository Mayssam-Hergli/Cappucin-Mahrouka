// countdown.js — délais critiques : dans combien de temps le feu atteint ce qui compte
// (bouteilles de gaz, solvants, armoires électriques, victimes, sorties), et dans combien
// de temps le drone atteint sa limite de chaleur (60 °C).
//
// Source : /api/state.forecast_eta = {"x,y": secondes simulées après forecast_t0}, calculé
// par le serveur sur une copie de la simulation, sans intervention. Le temps restant suit
// l'horloge de la Sim (s.t), il reste donc juste à toutes les vitesses de démo.
"use strict";

const Countdown = (() => {
  const SHOW = ["EN_ROUTE", "DRONE_INSIDE", "PLANS_READY"];
  const HORIZON = 300;            // au-delà de 5 min, on n'affiche pas
  const N4 = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
  let targets = null;
  const heat = [];                // historique [instant réel (s), °C] du drone
  let lastKey = "";

  // cibles fixes, regroupées par zone (une ligne par type et par zone)
  function buildTargets(f) {
    const zoneOf = (x, y) => (f.zones || []).find(z => x >= z.rect[0] && x <= z.rect[2] && y >= z.rect[1] && y <= z.rect[3]);
    const groups = new Map();
    const add = (kind, label, picto, x, y) => {
      const z = zoneOf(x, y);
      const key = kind + ":" + (z ? z.id : "?");
      if (!groups.has(key)) groups.set(key, { kind, label, picto, zone: z ? z.id : "", cells: [] });
      groups.get(key).cells.push([x, y]);
    };
    f.grid.forEach((row, y) => [...row].forEach((c, x) => {
      if (c === "G") add("gas", "bouteilles de gaz", "gas", x, y);
      else if (c === "F") add("solvent", "solvants", "solvent", x, y);
      else if (c === "X") add("electric", "armoire électrique", "electric", x, y);
    }));
    for (const v of f.gas_valves || []) add("valve", "vanne gaz " + v.id, "valve", v.x, v.y);
    const fixed = [...groups.values()];
    for (const e of f.exits || []) fixed.push({ kind: "exit", label: "sortie " + e.id, picto: "exit", zone: "", cells: [[e.x, e.y]] });
    return fixed;
  }

  // temps (s simulées) avant que le feu atteigne une des cellules (ou une voisine) ; 0 = déjà en feu
  function etaOf(cells, s) {
    const eta = s.forecast_eta || {};
    const elapsed = (s.t != null && s.forecast_t0 != null) ? s.t - s.forecast_t0 : 0;
    let best = Infinity;
    for (const [x, y] of cells) for (const [dx, dy] of N4) {
      const k = (x + dx) + "," + (y + dy);
      if (Live.fireNow.has(k)) return 0;
      if (eta[k] != null) best = Math.min(best, Math.max(1, eta[k] - elapsed));
    }
    return best;
  }

  function fmt(sec) {
    if (sec <= 0) return "EN FEU";
    if (sec < 45) return "< 1 min";
    return "~" + Math.round(sec / 60) + " min";
  }
  const sev = (sec) => (sec <= 0 ? "now" : sec < 120 ? "red" : sec < 240 ? "amber" : "grey");

  function droneRow(s) {
    const d = s.drone;
    if (!d || d.state === "OUT") { heat.length = 0; return null; }
    const now = performance.now() / 1000;
    heat.push([now, d.temp]);
    while (heat.length && now - heat[0][0] > 8) heat.shift();
    if (d.state === "RETURNING" && d.temp >= 60) return { sec: 0, text: "Drone : limite de chaleur atteinte, retour automatique", tag: "RETOUR", cls: "now" };
    if (heat.length < 4) return null;
    const [t0, c0] = heat[0], [t1, c1] = heat[heat.length - 1];
    const slope = (c1 - c0) / Math.max(0.5, t1 - t0);          // °C par seconde réelle
    if (slope < 0.05) return { sec: Infinity, text: `Drone : ${Math.round(d.temp)} °C, température stable`, tag: "STABLE", cls: "grey" };
    const rem = (60 - d.temp) / slope;
    return { sec: rem, text: "Limite de chaleur du drone (60 °C)", tag: rem < 30 ? "< 30 s" : "~" + Math.round(rem / 5) * 5 + " s", cls: rem < 30 ? "red" : "amber" };
  }

  // cibles atteintes par le feu dans les 5 min, triées (la plus urgente d'abord)
  function computeRows(s) {
    if (!targets) targets = buildTargets(Live.factory);
    const rows = [];
    for (const tg of targets) {
      const sec = etaOf(tg.cells, s);
      if (sec <= HORIZON) rows.push({ sec, tg, text: `Feu → ${tg.label}`, tag: fmt(sec), cls: sev(sec), at: tg.cells[0], zone: tg.zone, picto: tg.picto });
    }
    for (const v of s.victims || []) {
      if (!v.found) continue;
      const sec = etaOf([[v.x, v.y]], s);
      if (sec <= HORIZON) rows.push({ sec, text: `Feu → victime ${v.id}`, tag: fmt(sec), cls: sev(sec), at: [v.x, v.y], zone: "", picto: null, victim: v.id });
    }
    rows.sort((a, b) => a.sec - b.sec);
    return rows;
  }

  function render(s) {
    const card = document.getElementById("cardCountdown");
    if (!card) return;
    const on = SHOW.includes(s.phase);
    card.hidden = !on;
    if (!on) return;
    const rows = computeRows(s);
    const list = rows.slice(0, 5);
    const dr = droneRow(s);
    if (dr) list.unshift(dr);
    const noData = !Object.keys(s.forecast_eta || {}).length;
    const key = JSON.stringify(list.map(r => [r.text, r.tag, r.cls])) + noData;
    if (key === lastKey) return;
    lastKey = key;
    const ul = document.getElementById("countdowns");
    if (!list.length) {
      ul.innerHTML = `<li class="cd-empty">${noData ? "Prévision en cours de calcul…" : "Aucune cible atteinte par le feu dans les 5 prochaines minutes."}</li>`;
      return;
    }
    ul.innerHTML = list.map((r, i) => `<li class="cd cd-${r.cls}"${r.at ? ` data-i="${i}" tabindex="0" role="button"` : ""}>
      <span class="cd-tag">${U.esc(r.tag)}</span>
      <span class="cd-txt">${r.picto ? Icons.picto(r.picto, "cd-pic") : ""}${U.esc(r.text)}</span>
      <span class="cd-zone">${U.esc(r.zone || "")}</span></li>`).join("");
    ul.querySelectorAll("[data-i]").forEach(li => {
      const r = list[+li.dataset.i];
      const go = () => {
        if (window.View3D && window.View3D.active && window.View3D.impl) window.View3D.impl.flyToCell(r.at[0], r.at[1], 9);
        else if (r.zone && typeof Loupe !== "undefined") Loupe.open(r.zone);
      };
      li.onclick = go;
      li.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
    });
  }

  return { init() { Live.on(render); }, rows: computeRows, fmt };
})();

(function waitLive() {
  if (typeof Live === "undefined" || !Live.factory) { setTimeout(waitLive, 100); return; }
  Countdown.init();
})();
