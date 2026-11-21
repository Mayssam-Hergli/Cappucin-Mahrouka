// action.js — bandeau « Action immédiate » + fiches de danger par zone.
//
// Le bandeau résume en une phrase, lisible à 3 m, ce que le commandant doit faire
// maintenant. Il est construit à partir de données déjà présentes dans /api/state
// (phase, alarme, plans, victimes, zones) et des délais critiques (countdown.js).
// La fiche de danger dit comment attaquer le feu d'une zone en sécurité, selon les
// matériaux et équipements qu'elle contient ; elle s'affiche dans la loupe.
"use strict";

const ACT_SIDE = { N: "Nord", S: "Sud", E: "Est", W: "Ouest" };

function zoneAtCell(f, x, y) {
  return (f.zones || []).find(z => x >= z.rect[0] && x <= z.rect[2] && y >= z.rect[1] && y <= z.rect[3]) || null;
}
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

// ------------------------------------------------------------------ bandeau
const Action = {
  last: "",

  // phrase + niveau (red / amber / neutral / green)
  compose(s) {
    const f = Live.factory, parts = [];
    let level = "neutral", tag = "SURVEILLANCE";
    const victims = (s.victims || []).filter(v => v.found);
    const urgent = (typeof Countdown !== "undefined" && ["EN_ROUTE", "DRONE_INSIDE", "PLANS_READY"].includes(s.phase))
      ? Countdown.rows(s).find(r => r.sec > 0) : null;
    const urgentTxt = (r) => {
      const t = r.tag.replace("< 1 min", "moins d'1 min");
      const z = r.zone ? ` ${r.zone}` : "";
      if (r.victim) return `feu sur ${r.victim} dans ${t}`;
      const k = r.tg && r.tg.kind;
      if (k === "gas" || k === "valve") return `risque d'explosion${z} dans ${t}`;
      if (k === "solvent") return `feu aux solvants${z} dans ${t}`;
      if (k === "electric") return `feu sur l'armoire électrique${z} dans ${t}`;
      if (k === "exit") return `${r.tg.label} menacée dans ${t}`;
      return `${r.text.toLowerCase()} dans ${t}`;
    };
    const victimTxt = () => {
      if (!victims.length) return null;
      const zones = [...new Set(victims.map(v => (zoneAtCell(f, v.x, v.y) || {}).id).filter(Boolean))];
      const inj = victims.filter(v => v.status === "injured").length;
      const mute = victims.filter(v => v.status === "no_answer").length;
      let t = `${plural(victims.length, "victime", "victimes")} ${zones.length === 1 ? "en " + zones[0] : "(" + zones.join(", ") + ")"}`;
      const extra = [];
      if (inj) extra.push(`${inj} ${inj > 1 ? "blessées" : "blessée"}`);
      if (mute) extra.push(`${mute} sans réponse`);
      if (extra.length) t += `, dont ${extra.join(" et ")}`;
      return t;
    };
    const fireZones = () => {
      const ids = new Set();
      for (const k of Live.fireNow) { const [x, y] = k.split(",").map(Number); const z = zoneAtCell(f, x, y); if (z) ids.add(z.id); }
      return [...ids];
    };
    const exitTxt = (id) => {
      const e = (f.exits || []).find(x => x.id === id);
      return e && e.side ? `${id} (${ACT_SIDE[e.side] || e.side})` : id;
    };

    switch (s.phase) {
      case "ALERT": {
        const a = s.alarm || {};
        level = "red"; tag = "ALERTE";
        parts.push("Appeler l'usine pour lever le doute");
        parts.push(`alarme ${a.zone || "?"}${a.node ? ", capteur " + a.node : ""}`);
        break;
      }
      case "CHECKING":
        level = "amber"; tag = "LEVÉE DE DOUTE";
        parts.push("Attendre la réponse de l'usine");
        parts.push(`alarme ${(s.alarm || {}).zone || "?"}`);
        break;
      case "FALSE_ALARM":
        tag = "FAUSSE ALARME";
        parts.push("Fausse alarme confirmée par l'usine, retour en surveillance");
        break;
      case "CONFIRMED":
      case "EN_ROUTE": {
        level = "amber"; tag = "EN ROUTE";
        const z = fireZones();
        parts.push("Choisir la porte d'entrée du drone et le lancer");
        if (z.length) parts.push(`feu en ${z.join(", ")}`);
        break;
      }
      case "DRONE_INSIDE": {
        level = "amber"; tag = "RECONNAISSANCE";
        const d = s.drone, dz = d ? zoneAtCell(f, d.x, d.y) : null;
        parts.push(d && d.state === "RETURNING" ? "Drone en retour vers la sortie" : `Reconnaissance en cours${dz ? ", drone en " + dz.id : ""}`);
        parts.push(victimTxt() || "aucune victime trouvée pour l'instant");
        break;
      }
      case "PLANS_READY": {
        level = "green"; tag = "ACTION";
        const e = s.plans && s.plans.entry;
        parts.push(e && e.door ? `Entrer par ${exitTxt(e.door)}` : "Valider le plan d'entrée");
        const vt = victimTxt(); if (vt) parts.push(vt);
        break;
      }
      default:
        parts.push("Aucun incident, capteurs de l'usine sous surveillance");
    }
    if (urgent) {
      parts.push(urgentTxt(urgent));
      if (urgent.sec < 120) level = "red";
      else if (level !== "red") level = "amber";
    }
    if (s.phase === "PLANS_READY") parts.push("valider les plans");
    return { level, tag, text: parts.join(" — ") };
  },

  onState(s) {
    const el = document.getElementById("actionStrip");
    if (!el) return;
    const a = this.compose(s);
    const key = a.level + a.tag + a.text;
    if (key === this.last) return;
    this.last = key;
    el.className = "action-strip lvl-" + a.level;
    el.innerHTML = `<span class="as-tag">${U.esc(a.tag)}</span><span class="as-txt">${U.esc(a.text)}</span>`;
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
  Live.on((s) => Action.onState(s));
  if (Live.s) Action.onState(Live.s);
})();
