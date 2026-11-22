// zonecards.js — bilan de chaque zone, en tête de la colonne de droite, une fois la
// reconnaissance du drone terminée (il remplace alors la caméra du drone, sorti du bâtiment).
// Rien n'est posé sur la carte : la carte reste le guide (itinéraires, étapes, victimes),
// le bilan se lit à côté.
//
// Une ligne par zone, la plus grave en tête, avec seulement ce qui décide de l'engagement
// des pompiers, dans cet ordre :
//   1. victimes (qui, dans quel état)
//   2. feu (surface en feu, ou dans combien de temps il arrive)
//   3. air : les mesures les plus graves + ARI obligatoire / air respirable
//   4. danger principal et le geste qui va avec (vanne gaz, coupure électrique, mousse)
//   5. part de la zone vue par le drone (une zone peu vue n'est pas une zone sûre)
// Clic sur une zone : la caméra 3D y va (en 2D, la fiche détaillée s'ouvre).
"use strict";

const ZoneCards = (() => {
  const SHOW = "PLANS_READY";              // après le tour du drone (drone sorti, plans prêts)
  const VSTATUS = { injured: "blessée", walking: "valide", no_answer: "sans réponse" };
  const SHORT = {
    temp: (v) => `${v} °C`, co: (v) => `CO ${v} ppm`, o2: (v) => `O₂ ${v} %`,
    smoke: (v) => `Fumée ${v} %`, gas: (v) => `Gaz ${v} % LIE`, mq: (v) => `Capteur ${v}`,
  };
  const HAZ_PIC = { "EXPLOSION": "gas", "ÉLECTRIQUE": "electric", "INFLAMMABLE": "solvent", "BRÛLURE": "metal" };
  const RANK = { danger: 3, warn: 2, unk: 1, ok: 0 };
  let last = "";

  // Valeurs stables à l'écran : arrondies, et le chiffre affiché ne change que si l'écart
  // dépasse un seuil. Sans ça, le petit bruit des capteurs simulés (zones.py) faisait danser
  // les décimales toutes les 0,5 s alors que rien ne se passait.
  const STEP = {
    temp: (v) => Math.max(1, Math.abs(v) * 0.03), co: (v) => Math.max(3, Math.abs(v) * 0.05),
    o2: () => 0.3, smoke: () => 5, gas: () => 2, mq: (v) => Math.max(20, Math.abs(v) * 0.05),
  };
  const DEC = { o2: 1 };                    // O₂ : 1 décimale (seuil ARI à 19,5 %) ; le reste en entier
  const shownVal = new Map();               // "zone:type" -> valeur affichée
  function stable(zid, type, v) {
    const k = zid + ":" + type, old = shownVal.get(k), step = (STEP[type] || (() => 1))(v);
    const keep = old != null && Math.abs(v - old) < step;
    const out = keep ? old : v;
    shownVal.set(k, out);
    const d = DEC[type] || 0;
    return (Math.round(out * 10 ** d) / 10 ** d).toFixed(d).replace(".", ",");
  }

  const inRect = (r, x, y) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
  const nearest = (list, cx, cy) => (list || []).slice()
    .sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy))[0];

  function summary(s, z) {
    const f = Live.factory, zs = (s.zones || {})[z.id] || {}, r = z.rect;
    const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
    const rows = [];

    // victimes : toujours en premier
    const vic = (s.victims || []).filter(v => v.found && inRect(r, v.x, v.y));
    if (vic.length) {
      const st = (v) => VSTATUS[v.status] || "état inconnu";
      rows.push({ ic: Icons.ui("person"), cls: "red",
        html: vic.length === 1 ? `Victime <b>${U.esc(vic[0].id)}</b> · ${st(vic[0])}`
          : `<b>${vic.length} victimes</b> · ${vic.map(v => `${U.esc(v.id)} ${st(v)}`).join(", ")}` });
    }

    // feu : surface en feu (1 cellule = 1 m²), sinon arrivée prévue, sinon déjà éteint
    let fire = 0, burnt = 0;
    for (const k of Live.fireNow) { const [x, y] = k.split(",").map(Number); if (inRect(r, x, y)) fire++; }
    for (const k of Live.burnt) { const [x, y] = k.split(",").map(Number); if (inRect(r, x, y)) burnt++; }
    let eta = Infinity;
    if (!fire) {
      const E = s.forecast_eta || {}, el = (s.t != null && s.forecast_t0 != null) ? s.t - s.forecast_t0 : 0;
      for (const [k, v] of Object.entries(E)) {
        const [x, y] = k.split(",").map(Number);
        if (inRect(r, x, y)) eta = Math.min(eta, Math.max(1, v - el));
      }
    }
    const fmtEta = (sec) => (typeof Countdown !== "undefined" ? Countdown.fmt(sec) : "~" + Math.round(sec / 60) + " min");
    if (fire) rows.push({ ic: Icons.ui("fire"), cls: "red", html: `<b>En feu</b> · ${fire} m²` });
    else if (eta <= 300) rows.push({ ic: Icons.ui("timer"), cls: eta < 120 ? "red" : "amber", html: `Feu attendu <b>${fmtEta(eta)}</b>` });
    else if (burnt) rows.push({ ic: Icons.ui("fire"), cls: "mute", html: `Feu éteint · ${burnt} m² brûlés` });

    // air : les 3 mesures les plus graves + consigne respiratoire
    const air = (zs.air || zs.top || []).slice();
    const by = Object.fromEntries(air.map(a => [a.type, a]));
    // les 3 mesures retenues : les anormales d'abord (les plus graves), puis toujours affichées
    // dans le même ordre. Trier l'affichage par gravité faisait permuter deux valeurs proches
    // (O₂ et fumée) à chaque petit changement de tendance.
    const ORDER = ["temp", "co", "o2", "smoke", "gas", "mq"];
    const bad = (a) => a.score >= 0.6;
    const shown = air.filter(a => a.type !== "mq" || !(by.co || by.smoke))
      .sort((a, b) => (bad(b) - bad(a)) || (bad(a) ? b.score - a.score : ORDER.indexOf(a.type) - ORDER.indexOf(b.type)))
      .slice(0, 3)
      .sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
    const ari = (by.co && by.co.value >= 50) || (by.o2 && by.o2.value < 19.5) || (by.smoke && by.smoke.value >= 30);
    const breathOk = !ari && by.co && by.o2 && by.co.src === "drone" && by.o2.src === "drone";
    if (shown.length) {
      const vals = shown.map(a => {
        const c = a.score >= 1 ? "red" : a.score >= 0.6 ? "amber" : "";
        const tr = a.trend === "up" ? (a.type === "o2" ? " ↓" : " ↑") : "";
        const v = stable(z.id, a.type, a.value);
        return `<span class="zc-v ${c}">${U.esc(SHORT[a.type] ? SHORT[a.type](v) : v)}${tr}</span>`;
      }).join("");
      const tag = ari ? '<span class="zc-tag red">ARI obligatoire</span>'
        : breathOk ? '<span class="zc-tag ok">Air respirable</span>' : "";
      rows.push({ ic: Icons.ui(by.temp && by.temp.score >= 1 ? "thermo" : "o2"), cls: "air", html: vals + tag });
    }

    // danger principal (calculé par le serveur selon la distance au feu) + le geste
    const valve = (f.gas_valves || []).find(g => g.zone === z.id) || nearest(f.gas_valves, cx, cy);
    const cut = (f.power_cutoffs || []).find(p => p.zone === z.id) || nearest(f.power_cutoffs, cx, cy);
    const ACT = {
      "EXPLOSION": valve ? `fermer la vanne ${valve.id}` : "fermer la vanne gaz",
      "ÉLECTRIQUE": cut ? `couper le courant (${cut.id})` : "couper le courant avant l'eau",
      "INFLAMMABLE": "mousse, pas de jet d'eau",
      "BRÛLURE": "métal chaud, risque d'effondrement",
    };
    const dyn = (zs.risk_tags || []).find(t => ACT[t.tag]);
    if (dyn) {
      rows.push({ ic: Icons.picto(HAZ_PIC[dyn.tag]), cls: dyn.sev >= 3 ? "red" : "amber",
        html: `<b>${U.esc(dyn.tag[0] + dyn.tag.slice(1).toLowerCase())}</b> · ${U.esc(ACT[dyn.tag])}` });
    } else {
      // pas encore menacé : on dit quand même ce que la zone contient
      const has = new Set();
      for (let y = r[1]; y <= r[3]; y++) for (let x = r[0]; x <= r[2]; x++) has.add((f.grid[y] || "")[x]);
      const eq = new Set((f.equipment || []).filter(e => inRect(r, e.x, e.y)).map(e => e.type));
      const what = [];
      if (has.has("G") || eq.has("gas") || eq.has("valve")) what.push("gaz");
      if (has.has("F") || eq.has("solvent")) what.push("solvants");
      if (has.has("X") || eq.has("electric")) what.push("armoire électrique");
      if (what.length) rows.push({ ic: Icons.ui("alert"), cls: "mute", html: `Contient : ${what.join(", ")}` });
    }

    // statut de la zone
    const scanned = zs.scanned || 0, seen = air.some(a => a.src === "drone");
    let st;
    if (zs.level === "DANGER" || fire) st = { k: "danger", t: "DANGER" };
    else if (zs.level === "WARNING" || eta <= 180) st = { k: "warn", t: "VIGILANCE" };
    else if (scanned < 0.25 && !seen) st = { k: "unk", t: "PEU VUE" };
    else st = { k: "ok", t: "RAS" };
    if (vic.length && st.k === "ok") st = { k: "warn", t: "VICTIME" };

    const foot = scanned >= 0.8 ? "" : scanned <= 0.02 ? "Non vue par le drone : capteurs fixes seuls"
      : `Vue à ${Math.round(scanned * 100)} % par le drone`;
    return { id: z.id, name: z.label_fr || z.name || "", st, rows, foot, rank: RANK[st.k] * 10 + vic.length };
  }

  function itemHtml(s) {
    return `<li><button type="button" class="zc zc-${s.st.k}" data-z="${U.esc(s.id)}" title="Voir la zone sur la carte">`
      + `<span class="zc-head"><b class="zc-id">${U.esc(s.id)}</b><span class="zc-name">${U.esc(s.name)}</span>`
      + `<span class="zc-st">${s.st.t}</span></span>`
      + s.rows.map(r => `<span class="zc-row ${r.cls || ""}">${r.ic}<span class="zc-tx">${r.html}</span></span>`).join("")
      + (!s.rows.length ? '<span class="zc-row mute"><span class="zc-tx">Rien à signaler</span></span>' : "")
      + (s.foot ? `<span class="zc-foot">${U.esc(s.foot)}</span>` : "")
      + "</button></li>";
  }

  function onState(s) {
    const card = document.getElementById("cardZones");
    if (!card) return;
    const on = !!s && s.phase === SHOW;
    card.hidden = !on;
    // le drone est sorti : sa caméra thermique n'apporte plus rien, le bilan prend sa place
    const drone = document.getElementById("cardDrone");
    if (drone) drone.hidden = on;
    if (!on) { last = ""; return; }
    const list = (Live.factory.zones || []).map(z => summary(s, z))
      .sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id));
    const html = list.map(itemHtml).join("");
    if (html === last) return;
    last = html;
    const ul = document.getElementById("zoneList");
    ul.innerHTML = html;
    ul.querySelectorAll("[data-z]").forEach(b => b.onclick = () => openZone(b.dataset.z));
    const n = list.filter(z => z.st.k === "danger").length;
    document.getElementById("zoneCount").textContent = n ? `${n} en danger` : "";
  }

  // 3D : la caméra va sur la zone (la carte reste dégagée) ; 2D : fiche détaillée (loupe)
  function openZone(id) {
    if (window.View3D && window.View3D.active) window.View3D.flyToZone(id);
    else if (typeof Loupe !== "undefined") Loupe.open(id);
  }

  function init() {
    Live.on(onState);
    if (Live.s) onState(Live.s);
  }

  return { init, summary, stable };
})();

(function waitLive() {
  if (typeof Live === "undefined" || !Live.factory || typeof Icons === "undefined") { setTimeout(waitLive, 100); return; }
  ZoneCards.init();
})();
