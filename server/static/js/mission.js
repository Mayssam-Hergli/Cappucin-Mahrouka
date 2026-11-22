// mission.js — ordre d'intervention des pompiers, dessiné sur la carte et listé dans le panneau.
//
// À partir des plans de la Sim (évacuation, porte d'entrée, extinction), on construit une
// suite d'étapes numérotées, chacune avec son itinéraire depuis une porte :
//   1. SAUVETAGE : chaque victime qui ne peut pas sortir seule (blessée, ne répond pas, état
//      inconnu, ou sans chemin sûr), la plus menacée par le feu d'abord ;
//   2. MISE EN SÉCURITÉ : couper le courant, fermer la vanne gaz (demandé par le plan d'extinction) ;
//   3. ATTAQUE : pour chaque foyer, dans l'ordre de la Sim, une position de lance du côté
//      conseillé, la porte la plus sûre pour l'atteindre et la bouche d'incendie où s'établir.
// Les itinéraires évitent le feu, la fumée, le gaz, les abords du feu et les passages que la
// prévision donne en feu dans moins de 3 minutes. Sur chaque itinéraire on signale le premier
// passage enfumé (ARI), gazé (explosimètre) et le premier passage menacé par le feu.
// Ce module ne fait que lire /api/state : rien n'est envoyé à la Sim.
"use strict";

const Mission = (() => {
  const SHOW = ["PLANS_READY"];   // ordre d'intervention seulement une fois le scan terminé
  const N8 = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
  const SIDE = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };
  const FROM = { N: "depuis le nord", S: "depuis le sud", E: "depuis l'est", W: "depuis l'ouest" };
  const AGENT = { water: "eau", foam: "mousse", powder: "poudre", CO2: "CO₂" };
  const STATUS = { injured: "blessée", no_answer: "ne répond pas" };
  const STATUS_RANK = { no_answer: 0, injured: 1 };
  const THREAT = 180;          // s : un passage qui s'embrase avant ce délai est « menacé »
  const STAND_OFF = 2.5;       // m : distance de la lance au front du feu
  let cache = { s: null, m: null };

  // file de priorité minimale (tas binaire) sur des indices de cellule
  class Heap {
    constructor() { this.k = []; this.v = []; }
    get size() { return this.k.length; }
    push(key, val) {
      const k = this.k, v = this.v; let i = k.length;
      k.push(key); v.push(val);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (k[p] <= key) break;
        k[i] = k[p]; v[i] = v[p]; i = p;
      }
      k[i] = key; v[i] = val;
    }
    pop() {
      const k = this.k, v = this.v, top = [k[0], v[0]];
      const lk = k.pop(), lv = v.pop(), n = k.length;
      if (n) {
        let i = 0;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= n) break;
          if (c + 1 < n && k[c + 1] < k[c]) c++;
          if (k[c] >= lk) break;
          k[i] = k[c]; v[i] = v[c]; i = c;
        }
        k[i] = lk; v[i] = lv;
      }
      return top;
    }
  }

  function build(s) {
    const f = Live.factory, W = f.grid[0].length, H = f.grid.length;
    const plans = s.plans || {};
    const fire = Live.fireNow, smoke = Live.smokeNow, gas = Live.gasNow;
    const key = (x, y) => x + "," + y;
    const walk = (x, y) => x >= 0 && y >= 0 && x < W && y < H && ".DE".includes(f.grid[y][x]);
    const zoneOf = (x, y) => (f.zones || []).find(z => x >= z.rect[0] && x <= z.rect[2] && y >= z.rect[1] && y <= z.rect[3]);

    // délai avant embrasement (s), d'après la prévision du serveur
    const eta = s.forecast_eta || {};
    const elapsed = (s.t != null && s.forecast_t0 != null) ? s.t - s.forecast_t0 : 0;
    const etaAt = (k) => fire.has(k) ? 0 : eta[k] != null ? Math.max(1, eta[k] - elapsed) : Infinity;

    // abords du feu (chaleur) : distance de Tchebychev 1 ou 2
    const near = new Map();
    for (const k of fire) {
      const [x, y] = k.split(",").map(Number);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const kk = key(x + dx, y + dy), d = Math.max(Math.abs(dx), Math.abs(dy));
        if (d && (!near.has(kk) || near.get(kk) > d)) near.set(kk, d);
      }
    }
    const cost = new Float64Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = key(x, y), d = near.get(k);
      let c = 1;
      if (d === 1) c += 4; else if (d === 2) c += 1.5;
      if (smoke.has(k)) c += 3;
      if (gas.has(k)) c += 6;
      if (etaAt(k) < THREAT) c += 6;
      cost[y * W + x] = c;
    }

    // grilles précalculées : marchable, et marchable hors feu
    const WALK = new Uint8Array(W * H), OPEN = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!walk(x, y)) continue;
      WALK[y * W + x] = 1;
      if (!fire.has(key(x, y))) OPEN[y * W + x] = 1;
    }
    const inG = (x, y) => x >= 0 && y >= 0 && x < W && y < H;

    // Dijkstra depuis une porte : coût vers toutes les cellules (pas de coin coupé, feu bloquant)
    function fromDoor(sx, sy) {
      const dist = new Float64Array(W * H).fill(Infinity), prev = new Int32Array(W * H).fill(-1);
      const h = new Heap();
      dist[sy * W + sx] = 0; h.push(0, sy * W + sx);
      while (h.size) {
        const [d, i] = h.pop();
        if (d > dist[i]) continue;
        const x = i % W, y = (i - x) / W;
        for (const [dx, dy, len] of N8) {
          const nx = x + dx, ny = y + dy;
          if (!inG(nx, ny)) continue;
          const j = ny * W + nx;
          if (!OPEN[j]) continue;
          if (dx && dy && !(WALK[y * W + x + dx] && WALK[(y + dy) * W + x])) continue;
          const nd = d + len * cost[j];
          if (nd < dist[j]) { dist[j] = nd; prev[j] = i; h.push(nd, j); }
        }
      }
      return {
        dist: (x, y) => dist[y * W + x],
        path(x, y) {
          let i = y * W + x;
          if (!isFinite(dist[i])) return null;
          const out = [];
          while (i >= 0) { out.push([i % W, Math.floor(i / W)]); i = prev[i]; }
          return out.reverse();
        },
      };
    }
    const doors = {};
    for (const e of f.exits || []) doors[e.id] = { e, map: fromDoor(e.x, e.y) };
    // porte la plus sûre ; la porte conseillée par la Sim reste choisie si elle n'est pas
    // beaucoup plus longue (une seule équipe engagée par une seule porte, tant que c'est raisonnable)
    const bestDoor = (x, y, prefer) => {
      let best = null;
      for (const d of Object.values(doors)) if (!best || d.map.dist(x, y) < best.map.dist(x, y)) best = d;
      if (!best || !isFinite(best.map.dist(x, y))) return null;
      const p = prefer && doors[prefer];
      if (p && p.map.dist(x, y) <= best.map.dist(x, y) * 1.25 + 4) return p;
      return best;
    };
    const walkCell = (x, y) => {       // cellule où se tenir pour agir sur un équipement
      if (walk(x, y)) return [x, y];
      let best = null;
      for (const [dx, dy] of N8) if (walk(x + dx, y + dy) && !fire.has(key(x + dx, y + dy))) { best = [x + dx, y + dy]; break; }
      return best;
    };

    const routes = [], steps = [], hoses = [], lances = [];

    // longueur d'un chemin (m) + dangers rencontrés
    function addRoute(kind, path) {
      let len = 0, minEta = Infinity, threatAt = null, smokeAt = null, gasAt = null;
      const threat = new Set();
      path.forEach(([x, y], i) => {
        if (i) len += (x !== path[i - 1][0] && y !== path[i - 1][1]) ? Math.SQRT2 : 1;
        const k = key(x, y), t = etaAt(k);
        if (t < THREAT) { threat.add(i); if (t < minEta) { minEta = t; threatAt = [x, y]; } }
        if (!smokeAt && smoke.has(k)) smokeAt = [x, y];
        if (!gasAt && gas.has(k)) gasAt = [x, y];
      });
      const hazards = [];
      if (smokeAt) hazards.push({ at: smokeAt, kind: "smoke", text: "Fumée : ARI" });
      if (gasAt) hazards.push({ at: gasAt, kind: "gas", text: "Gaz : explosimètre" });
      if (threatAt) hazards.push({ at: threatAt, kind: "threat", text: `Feu ici ${minEta < 45 ? "< 1 min" : "~" + Math.round(minEta / 60) + " min"}` });
      const r = { kind, path, threat, hazards, len: Math.round(len), minEta };
      routes.push(r);
      return r;
    }
    const warnOf = (r) => {
      const w = [];
      if (r.hazards.some(h => h.kind === "smoke")) w.push("fumée, ARI obligatoire");
      if (r.hazards.some(h => h.kind === "gas")) w.push("gaz, explosimètre");
      if (isFinite(r.minEta)) w.push(`passage menacé par le feu dans ${r.minEta < 45 ? "moins d'1 min" : "~" + Math.round(r.minEta / 60) + " min"}`);
      return w.join(" ; ");
    };

    // 1. sauvetages
    const vById = Object.fromEntries((s.victims || []).map(v => [v.id, v]));
    const rescue = (plans.evacuation || []).filter(e => e.rescue_first && vById[e.victim]).map(e => {
      const v = vById[e.victim];
      let t = Infinity;
      for (const [dx, dy] of [[0, 0], ...N8]) t = Math.min(t, etaAt(key(v.x + dx, v.y + dy)));
      return { e, v, t };
    });
    const entryDoor = plans.entry && plans.entry.door;
    rescue.sort((a, b) => (a.t - b.t) || ((STATUS_RANK[a.v.status] ?? 2) - (STATUS_RANK[b.v.status] ?? 2))
      || ((doors[entryDoor] ? doors[entryDoor].map.dist(a.v.x, a.v.y) - doors[entryDoor].map.dist(b.v.x, b.v.y) : 0)));
    let lastDoor = null;
    for (const { e, v, t } of rescue) {
      const d = bestDoor(v.x, v.y, entryDoor);
      if (!d) {
        steps.push({ kind: "rescue", x: v.x, y: v.y, victim: v.id,
          title: `Secourir ${v.id}`, sub: "aucun accès sûr depuis les portes : attendre l'attaque", warn: "" });
        continue;
      }
      // première victime : le chemin calculé par la Sim (vraies valeurs de chaleur) s'il y mène
      const simPath = plans.entry && plans.entry.door === d.e.id && plans.entry.path;
      const lastCell = simPath && simPath[simPath.length - 1];
      const path = lastCell && lastCell[0] === v.x && lastCell[1] === v.y ? simPath : d.map.path(v.x, v.y);
      const r = addRoute("rescue", path);
      const state = STATUS[v.status] || "état inconnu";
      const sub = [state, `${r.len} m depuis ${d.e.id}`];
      if (e.exit) sub.push(`évacuer par ${e.exit}`);
      if (isFinite(t)) sub.push(`feu sur la victime ${t < 45 ? "< 1 min" : "~" + Math.round(t / 60) + " min"}`);
      steps.push({ kind: "rescue", x: v.x, y: v.y, victim: v.id, route: r, urgent: t < THREAT,
        title: lastDoor === d.e.id ? `Secourir ${v.id}` : `Entrer par ${d.e.id}, secourir ${v.id}`,
        sub: sub.join(" · "), warn: warnOf(r) });
      lastDoor = d.e.id;
    }

    // 2. mise en sécurité (coupures demandées par le plan d'extinction)
    const ext = [...(plans.extinguish || [])].sort((a, b) => a.order - b.order);
    const done = new Set();
    for (const l of ext) for (const a of l.first || []) {
      const m = String(a).match(/^(close the gas valve|cut the power)\s*(\S+)?$/);
      if (!m) continue;
      const gasV = m[1].startsWith("close");
      const list = gasV ? f.gas_valves : f.power_cutoffs;
      const dev = (list || []).find(d => d.id === m[2]) || (list || [])[0];
      if (!dev || done.has(dev.id)) continue;
      done.add(dev.id);
      const c = walkCell(dev.x, dev.y), d = c && bestDoor(c[0], c[1]);
      const r = d ? addRoute("safety", d.map.path(c[0], c[1])) : null;
      steps.push({ kind: "safety", x: dev.x, y: dev.y, route: r,
        title: gasV ? `Fermer la vanne gaz ${dev.id}` : `Couper le courant ${dev.id}`,
        sub: [`avant l'attaque ${l.zone}`, r ? `${r.len} m depuis ${d.e.id}` : "accès à reconnaître"].join(" · "),
        warn: r ? warnOf(r) : "" });
    }

    // 3. attaques : position de lance du côté conseillé
    for (const l of ext) {
      const cells = [];
      for (const k of fire) { const [x, y] = k.split(",").map(Number); const z = zoneOf(x, y); if (z && z.id === l.zone) cells.push([x, y]); }
      if (!cells.length) continue;
      const dir = SIDE[l.attack_from] || [0, 0];
      const cx = l.at ? l.at[0] : cells.reduce((a, c) => a + c[0], 0) / cells.length;
      const cy = l.at ? l.at[1] : cells.reduce((a, c) => a + c[1], 0) / cells.length;
      const ext0 = Math.max(...cells.map(([x, y]) => (x - cx) * dir[0] + (y - cy) * dir[1]));
      const tx = cx + dir[0] * (ext0 + STAND_OFF), ty = cy + dir[1] * (ext0 + STAND_OFF);
      let best = null;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const k = key(x, y);
        if (!walk(x, y) || fire.has(k) || near.get(k) === 1 || f.grid[y][x] === "E") continue;
        if ((x - cx) * dir[0] + (y - cy) * dir[1] < ext0 + 1) continue;     // derrière le front, côté conseillé
        const d = bestDoor(x, y);
        if (!d) continue;
        const score = Math.hypot(x - tx, y - ty) + 0.04 * d.map.dist(x, y) + (smoke.has(k) ? 1.5 : 0);
        if (!best || score < best.score) best = { x, y, d, score };
      }
      const label = `${AGENT[l.agent] || l.agent} ${FROM[l.attack_from] || ""}`.trim();
      if (!best) {
        steps.push({ kind: "attack", zone: l.zone, x: Math.round(cx), y: Math.round(cy), noPos: true,
          title: `Attaque ${l.zone} : ${label}`, sub: "pas de position de lance sûre de ce côté", warn: "" });
        continue;
      }
      const r = addRoute("attack", best.d.map.path(best.x, best.y));
      // lance : vers la cellule en feu la plus proche
      const tgt = cells.reduce((a, c) => (Math.hypot(c[0] - best.x, c[1] - best.y) < Math.hypot(a[0] - best.x, a[1] - best.y) ? c : a));
      lances.push({ from: [best.x, best.y], to: tgt });
      // établissement : bouche d'incendie la plus proche de la porte
      const door = best.d.e;
      const hyd = (f.hydrants || []).map(h => Array.isArray(h) ? { id: "", x: h[0], y: h[1] } : h)
        .sort((a, b) => Math.hypot(a.x - door.x, a.y - door.y) - Math.hypot(b.x - door.x, b.y - door.y))[0];
      if (hyd) hoses.push({ hydrant: hyd, door });
      const sub = [`entrer par ${door.id}`, `${r.len} m`];
      if (hyd) sub.unshift(`établir sur ${hyd.id}`);
      steps.push({ kind: "attack", zone: l.zone, x: best.x, y: best.y, route: r,
        title: `Attaque ${l.zone} : ${label}`, sub: sub.join(" · "), warn: warnOf(r) });
    }

    steps.forEach((st, i) => { st.n = i + 1; if (st.route) st.route.n = i + 1; });
    const sig = JSON.stringify(steps.map(st => [st.n, st.kind, st.title, st.sub, st.warn]));
    return { steps, routes, hoses, lances, sig };
  }

  return {
    // mission de l'état courant (calculée une fois par état reçu), ou null hors reconnaissance
    get(s) {
      s = s || Live.s;
      if (!s || !Live.factory || !SHOW.includes(s.phase)) return null;
      if (cache.s !== s) cache = { s, m: build(s) };
      return cache.m.steps.length ? cache.m : null;
    },
    stepOfZone(m, zone) { const st = m && m.steps.find(x => x.kind === "attack" && x.zone === zone); return st ? st.n : null; },
  };
})();
