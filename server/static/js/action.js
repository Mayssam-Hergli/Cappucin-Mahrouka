// action.js — bandeau « Action immédiate » + fiches de danger par zone.
//
// Le bandeau résume en une phrase, lisible à 3 m, ce que le commandant doit faire
// maintenant. Il est construit à partir de données déjà présentes dans /api/state
// (phase, alarme, plans, victimes, zones) et des délais critiques (countdown.js).
// La fiche de danger dit comment attaquer le feu d'une zone en sécurité, selon les
// matériaux et équipements qu'elle contient ; elle s'affiche dans la loupe.
"use strict";


function zoneAtCell(f, x, y) {
  return (f.zones || []).find(z => x >= z.rect[0] && x <= z.rect[2] && y >= z.rect[1] && y <= z.rect[3]) || null;
}
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

// ------------------------------------------------------------------ bandeau
const Action = {
  last: "",

  // un ordre court (ce qu'il faut faire maintenant) + une seule urgence au plus.
  // Le reste (victimes, zones, capteurs) est déjà dans la colonne de droite.
  compose(s) {
    let level = "neutral", text = "";
    const urgent = (typeof Countdown !== "undefined" && ["EN_ROUTE", "DRONE_INSIDE", "PLANS_READY"].includes(s.phase))
      ? Countdown.rows(s).find(r => r.sec > 0) : null;
    const urgentTxt = (r) => {
      const z = r.zone ? ` ${r.zone}` : "";
      if (r.victim) return `Feu sur ${r.victim}`;
      const k = r.tg && r.tg.kind;
      if (k === "gas" || k === "valve") return `Explosion${z}`;
      if (k === "solvent") return `Solvants${z}`;
      if (k === "electric") return `Armoire électrique${z}`;
      if (k === "exit") return `${r.tg.label} menacée`;
      return r.text;
    };
    switch (s.phase) {
      case "ALERT": level = "red"; text = `Alarme ${(s.alarm || {}).zone || ""} : appeler l'usine`; break;
      case "CHECKING": level = "amber"; text = "Vrai feu ou fausse alarme ?"; break;
      case "FALSE_ALARM": text = "Fausse alarme, retour en surveillance"; break;
      case "CONFIRMED":
      case "EN_ROUTE": level = "amber"; text = "Choisir la porte et lancer le drone"; break;
      case "DRONE_INSIDE": {
        level = "amber";
        const d = s.drone;
        text = d && d.state === "RETURNING" ? "Drone en retour vers la sortie" : "Reconnaissance en cours";
        break;
      }
      case "PLANS_READY": {
        level = "green";
        const e = s.plans && s.plans.entry;
        const m = typeof Mission !== "undefined" ? Mission.get(s) : null;
        text = m ? m.steps[0].title : (e && e.door ? `Entrer par ${e.door}` : "Valider le plan d'entrée");
        break;
      }
      default: text = "Aucun incident";
    }
    let alert = "";
    if (urgent) {
      alert = `${urgentTxt(urgent)} · ${urgent.tag}`;
      if (urgent.sec < 120) level = "red";
      else if (level !== "red") level = "amber";
    }
    return { level, text, alert };
  },

  onState(s) {
    const el = document.getElementById("actionStrip");
    if (!el) return;
    const a = this.compose(s);
    const key = a.level + a.text + a.alert;
    if (key === this.last) return;
    this.last = key;
    el.className = "action-strip lvl-" + a.level;
    el.innerHTML = `<span class="as-txt">${U.esc(a.text)}</span>${a.alert ? `<span class="as-alert">${U.esc(a.alert)}</span>` : ""}`;
  },
};

// ------------------------------------------------------------------ barre d'infos
// Les mesures importantes, une ligne courte par zone en alerte (la plus grave d'abord),
// au-dessus de la carte au lieu d'étiquettes et de fenêtres qui s'ouvrent sur le plan.
// Un clic ouvre la fiche détaillée de la zone.
const InfoBar = {
  last: "",
  onState(s) {
    const el = document.getElementById("mapInfo");
    if (!el) return;
    const names = Object.fromEntries((Live.factory.zones || []).map(z => [z.id, z.label_fr || z.name || ""]));
    const rank = { DANGER: 2, WARNING: 1 };
    const items = Object.entries(s.zones || {})
      .filter(([, z]) => rank[z.level] && z.top && z.top.length)
      .map(([id, z]) => ({ id, lvl: z.level, r: z.top[0] }))
      .sort((a, b) => rank[b.lvl] - rank[a.lvl] || b.r.score - a.r.score)
      .slice(0, 3);
    const html = items.map(i => `<button type="button" class="mi ${i.lvl === "DANGER" ? "mi-red" : "mi-amber"}" data-z="${i.id}" title="Voir le détail de la zone">
        <b>${U.esc(i.id)}</b><span class="mi-zn">${U.esc(names[i.id])}</span>
        <span class="mi-val">${U.esc(i.r.label)} ${U.esc(U.fmt(i.r.value))} ${U.esc(i.r.unit)}${i.r.trend === "up" ? " ↑" : ""}</span></button>`).join("");
    if (html === this.last) return;
    this.last = html;
    // hauteur fixe, même vide : la carte ne saute pas quand une alerte apparaît
    el.innerHTML = html || '<span class="mi-ok">Aucune mesure anormale</span>';
    el.querySelectorAll("[data-z]").forEach(b => b.onclick = () => Loupe.open(b.dataset.z));
  },
};

// ------------------------------------------------------------------ fiches de danger
const HazardSheet = {
  // lignes de la fiche pour une zone : [{picto, tag, sev, text}]
  lines(zoneId) {
    const f = Live.factory;
    const z = (f.zones || []).find(zz => zz.id === zoneId);
    if (!z) return [];
    const [x0, y0, x1, y1] = z.rect;
    const inZ = (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const dist = (p) => Math.round(Math.hypot(p.x - cx, p.y - cy));
    const nearest = (list) => (list || []).slice().sort((a, b) => dist(a) - dist(b))[0];
    const count = { P: 0, F: 0, G: 0, X: 0 };
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const c = (f.grid[y] || "")[x];
      if (c in count) count[c]++;
    }
    const eq = (f.equipment || []).filter(e => inZ(e.x, e.y));
    const has = (t) => eq.some(e => e.type === t);
    const out = [];

    if (count.G || has("gas") || has("valve")) {
      const v = (f.gas_valves || []).find(g => g.zone === zoneId) || nearest(f.gas_valves);
      out.push({ picto: "gas", tag: "EXPLOSION", sev: 3,
        text: `Bouteilles de gaz : périmètre de sécurité, ${v ? `fermer la vanne ${v.id}${v.zone && v.zone !== zoneId ? " (" + v.zone + ")" : ""}` : "fermer la vanne gaz"}, refroidir à distance` });
    }
    if (count.F || has("solvent")) {
      out.push({ picto: "solvent", tag: "INFLAMMABLE", sev: 2, text: "Solvants : attaque à la mousse, pas de jet d'eau direct" });
    }
    if (count.X || has("electric")) {
      const pw = (f.power_cutoffs || []).find(p => p.zone === zoneId) || nearest(f.power_cutoffs);
      out.push({ picto: "electric", tag: "ÉLECTRIQUE", sev: 2,
        text: `Couper le courant avant l'eau${pw ? ` : coupure ${pw.id}${pw.zone && pw.zone !== zoneId ? " (" + pw.zone + ")" : ""}` : ""}` });
    }
    if (has("metal")) {
      out.push({ picto: "machine", tag: "BRÛLURE", sev: 1, text: "Machines : métal chaud, risque d'effondrement des structures" });
    }
    if (count.P) {
      out.push({ picto: null, tag: "CLASSE A", sev: 1, text: "Papier et bois : attaque à l'eau, déblai et surveillance des reprises" });
    }
    if (!out.length) out.push({ picto: null, tag: "CLASSE A", sev: 0, text: "Pas de produit dangereux recensé : attaque à l'eau" });

    const h = nearest(f.hydrants);
    const ext = eq.filter(e => e.type === "extinguisher");
    const means = [];
    if (h) means.push(`bouche d'incendie ${h.id} à ${dist(h)} m`);
    if (ext.length) means.push(ext.map(e => e.label.toLowerCase()).join(", "));
    if (means.length) out.push({ picto: h ? "hydrant" : "extinguisher", tag: "MOYENS", sev: 0, text: means.join(" ; ").replace(/^./, c => c.toUpperCase()) });

    const ex = nearest(f.exits);
    if (ex) out.push({ picto: "exit", tag: "SORTIE", sev: 0, text: `${ex.id}${ex.name ? " " + ex.name : ""}, à ${dist(ex)} m du centre de la zone` });
    return out;
  },

  fill(el, zoneId) {
    if (!el) return;
    const html = this.lines(zoneId).map(l => `<li>
      <span class="hs-pic">${l.picto ? Icons.picto(l.picto) : ""}</span>
      <span class="rtag sev${l.sev}">${U.esc(l.tag)}</span>
      <span class="hs-txt">${U.esc(l.text)}</span></li>`).join("");
    if (el.dataset.zone !== zoneId || el.innerHTML !== html) { el.innerHTML = html; el.dataset.zone = zoneId; }
  },
};

(function waitLive() {
  if (typeof Live === "undefined" || !Live.factory) { setTimeout(waitLive, 100); return; }
  Live.on((s) => { Action.onState(s); InfoBar.onState(s); });
  if (Live.s) { Action.onState(Live.s); InfoBar.onState(Live.s); }
})();
