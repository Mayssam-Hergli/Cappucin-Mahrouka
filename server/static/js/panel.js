// panel.js — tout ce qui n'est pas la carte : frise des phases, chrono, liaison,
// décisions (actions à faire maintenant + trace horodatée), drone, victimes, plans,
// journal, état des modules, vent.
// Règle : un texte qui n'aide pas le commandant à décider dans les 10 secondes
// est caché derrière un survol ou un dépliage.
"use strict";

const PHASE_FR = {
  NORMAL: "Surveillance", ALERT: "Alerte", CHECKING: "Levée de doute", CONFIRMED: "Feu confirmé",
  EN_ROUTE: "En route", DRONE_INSIDE: "Reconnaissance", PLANS_READY: "Plans prêts",
};
const PHASES = Object.keys(PHASE_FR);
const STATUS_FR = { walking: "Peut marcher", injured: "Blessé(e)", no_answer: "Ne répond pas" };
const STATUS_LOWER = { walking: "peut marcher", injured: "blessé(e)", no_answer: "ne répond pas" };
const CAUSE_FR = { gas: "gaz", temp: "température", flame: "flamme" };
const FIRE_CLASS_FR = { A: "Classe A, solides", B: "Classe B, liquides", C: "Classe C, gaz", E: "Électrique", electrical: "Électrique" };
const AGENT_FR = { water: "eau", foam: "mousse", powder: "poudre", CO2: "CO₂" };
const SIDE_FR = { N: "par le nord", S: "par le sud", E: "par l'est", W: "par l'ouest" };
const FROM_FR = { N: "depuis le nord", S: "depuis le sud", E: "depuis l'est", W: "depuis l'ouest" };
const firstFr = (a) => a.replace("close the gas valve", "fermer la vanne gaz").replace("cut the power", "couper le courant");
const WIND_DIRS = [0, 45, 90, 135, 180, 225, 270, 315];
// WIND_DIRS = angle de la flèche à l'écran (0 = vers l'est, sens horaire).
// Contrat de la Sim : deg = direction VERS laquelle souffle le vent, 0 = nord, 90 = est.
const windToSim = (screenDeg) => (screenDeg + 90) % 360;
const windFromSim = (simDeg) => ((Math.round(simDeg) - 90) % 360 + 360) % 360;
const hhmmss = (sec) => new Date(sec * 1000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

// forme de statut, lisible aussi en niveaux de gris
function statusShape(status, cls = "") {
  const k = status || "unknown";
  const d = {
    walking: '<circle cx="8" cy="8" r="6" fill="currentColor"/>',
    injured: '<path d="M8 1.6l6.6 12H1.4z" fill="currentColor"/>',
    no_answer: '<circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="2.2"/>',
    unknown: '<path d="M8 1.6L14.4 8 8 14.4 1.6 8z" fill="none" stroke="currentColor" stroke-width="2"/>',
  }[k];
  return `<svg class="shape ${k} ${cls}" viewBox="0 0 16 16" aria-hidden="true">${d}</svg>`;
}

const Panel = {
  entry: null, lastPhase: null, lastEventAt: 0, keys: {}, windIdx: 0, windBusy: 0, knownVictims: null,
  expanded: new Set(), lookOpen: new Set(), lastAlarm: null, plansLine: null,

  init(f) {
    this.f = f;
    this.zoneName = Object.fromEntries((f.zones || []).map(z => [z.id, z.name]));
    document.getElementById("stepper").innerHTML = PHASES.map(p =>
      `<li data-p="${p}"><span class="tk"></span><span class="nm">${PHASE_FR[p]}</span><span class="tm"></span></li>`).join("");
    const kmh = document.getElementById("windKmh");
    kmh.oninput = () => { document.getElementById("windKmhTxt").textContent = kmh.value + " km/h"; this.windBusy = performance.now(); };
    kmh.onchange = () => this.sendWind();
    document.getElementById("windDir").onclick = () => { this.windIdx = (this.windIdx + 1) % 8; this.windBusy = performance.now(); this.sendWind(); this._windArrow(); };
    // dépliage des victimes et des détails de plan (délégation : les listes sont redessinées)
    document.getElementById("victims").addEventListener("click", (ev) => {
      const row = ev.target.closest(".vrow");
      if (row) { this._toggle(this.expanded, row.dataset.v); return; }
      const b = ev.target.closest("[data-s]");
      if (b) Live.post("/api/victim/status", { victim: b.dataset.v, status: b.dataset.s });
    });
    document.getElementById("plans").addEventListener("click", (ev) => {
      const b = ev.target.closest(".more");
      if (b) this._toggle(this.lookOpen, b.dataset.z);
    });
  },

  _toggle(set, id) {
    if (set.has(id)) set.delete(id); else set.add(id);
    this.keys.victims = this.keys.plans = null;
    if (Live.s) { this._victims(Live.s); this._plans(Live.s); }
  },

  sendWind() {
    Live.post("/api/wind", { kmh: +document.getElementById("windKmh").value, deg: windToSim(WIND_DIRS[this.windIdx]) });
  },
  _windArrow() {
    document.getElementById("windDir").style.transform = `rotate(${WIND_DIRS[this.windIdx]}deg)`;
  },

  // ----------------------------------------------------------- à chaque état
  onState(s) {
    if (s.alarm) this.lastAlarm = s.alarm;
    if (s.phase === "NORMAL") this.plansLine = null;
    this._stepper(s);
    this._banner(s);
    this._action(s);
    this._decisions(s);
    this._victims(s);
    this._plans(s);
    this._log(s);
    this._health(s);
    if (s.wind && performance.now() - this.windBusy > 3000) {
      const k = document.getElementById("windKmh");
      k.value = Math.round(s.wind.kmh); document.getElementById("windKmhTxt").textContent = k.value + " km/h";
      this.windIdx = Math.max(0, WIND_DIRS.indexOf(windFromSim(s.wind.deg))); this._windArrow();
    }
    if (s.phase === "ALERT" && this.lastPhase !== "ALERT") this._beep();
    this.lastPhase = s.phase;
  },

  // ----------------------------------------------------------- à chaque image
  frame(now) {
    const s = Live.s; if (!s) return;
    const lag = (performance.now() - Live.at) / 1000;
    const live = document.getElementById("live");
    const stale = !Live.ok || lag > 2;
    live.classList.toggle("stale", stale);
    live.querySelector(".txt").textContent = stale ? "Liaison interrompue" : `Liaison ${lag.toFixed(1).replace(".", ",")} s`;
    const ch = document.getElementById("chrono");
    const a = s.marks && s.marks.ALERT;
    if (a && s.phase !== "NORMAL" && s.phase !== "FALSE_ALARM") {
      const sec = Math.max(0, Live.serverNow() - a);
      ch.textContent = `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
      ch.classList.add("on");
    } else { ch.textContent = "--:--"; ch.classList.remove("on"); }
    // drone : température, jauge, état
    const d = s.drone;
    const temp = d ? Tween.get("droneTemp", d.temp, 0.08) : null;
    document.getElementById("droneTemp").textContent = d ? Math.round(temp) : "--";
    const pctT = d ? U.clamp((temp - 20) / 60 * 100, 0, 100) : 0;
    document.getElementById("droneBar").style.clipPath = `inset(0 ${100 - pctT}% 0 0)`;
    const st = document.getElementById("droneState");
    const stateFr = { EXPLORING: "Exploration", RETURNING: "Retour automatique", OUT: "Sorti" };
    st.textContent = d ? stateFr[d.state] || d.state : "Au sol";
    st.dataset.state = d ? d.state : "";
  },

  // frise : noms seulement ; l'heure s'affiche sous la phase en cours, au survol pour les autres
  _stepper(s) {
    const idx = PHASES.indexOf(s.phase);
    for (const li of document.querySelectorAll("#stepper li")) {
      const p = li.dataset.p, i = PHASES.indexOf(p);
      li.className = "";
      const t = s.marks && s.marks[p];
      const reached = t && (s.phase === "FALSE_ALARM" ? i <= 2 : i <= idx);
      const time = reached ? hhmmss(t) : "";
      li.querySelector(".tm").textContent = time;
      li.title = reached ? `${PHASE_FR[p]}, atteinte à ${time}` : PHASE_FR[p];
      if (s.phase === "FALSE_ALARM") {
        if (p === "CHECKING") li.className = "false";
        else if (i < 2) li.className = "done";
        continue;
      }
      if (i < idx) li.className = "done";
      if (i === idx) li.className = "now";
    }
  },

  _banner(s) {
    const b = document.getElementById("banner");
    let txt = "", cls = "";
    const d = s.drone;
    if (s.phase === "ALERT" && s.alarm) { txt = `Alarme en zone ${s.alarm.zone}, ${CAUSE_FR[s.alarm.cause] || s.alarm.cause}, capteur ${s.alarm.node}`; cls = "red"; }
    else if (s.phase === "CHECKING") { txt = "Appel de l'usine : vrai feu ou fausse alarme ?"; cls = "yellow"; }
    else if (s.phase === "FALSE_ALARM") { txt = "Fausse alarme confirmée par l'usine"; cls = "yellow"; }
    else if (s.phase === "EN_ROUTE") { txt = "En route. Contour pointillé : le feu prévu dans 3 minutes"; cls = "blue"; }
    else if (s.phase === "DRONE_INSIDE" && d && d.state === "RETURNING" && d.temp >= 55) { txt = `Drone à ${Math.round(d.temp)} °C : retour automatique`; cls = "red"; }
    else if (s.phase === "DRONE_INSIDE") { txt = "Reconnaissance : la carte se découvre autour du drone"; cls = "blue"; }
    else if (s.phase === "PLANS_READY") { txt = "Bâtiment scanné. Plans recommandés prêts"; cls = "green"; }
    const c = "banner " + cls + (txt ? " show" : "");
    if (b.textContent !== txt) b.textContent = txt;
    if (b.className !== c) b.className = c;
  },

  _recommendedExit(s) {
    const fire = (s.fire || []);
    if (!fire.length) return (this.f.exits[0] || {}).id;
    let best = null;
    for (const e of this.f.exits) {
      let dmin = Infinity;
      for (const [x, y] of fire) dmin = Math.min(dmin, Math.abs(x - e.x) + Math.abs(y - e.y));
      const score = dmin < 6 ? 1e9 : dmin;
      if (!best || score < best.score) best = { id: e.id, score };
    }
    return best.id;
  },

  // actions que l'opérateur doit encore faire, uniquement pendant leur phase
  _action(s) {
    const box = document.getElementById("actNow");
    const card = document.getElementById("cardAction");
    const reco = s.phase === "EN_ROUTE" ? this._recommendedExit(s) : null;
    if (s.phase === "EN_ROUTE" && !this.entry) this.entry = reco;
    if (s.phase !== "EN_ROUTE") this.entry = null;
    const key = JSON.stringify([s.phase, this.entry, reco, s.alarm && s.alarm.at]);
    if (this.keys.action === key) return;
    this.keys.action = key;
    const zone = s.alarm ? `${s.alarm.zone} ${this.zoneName[s.alarm.zone] || ""}` : "";
    let tone = "", h = "";
    switch (s.phase) {
      case "ALERT":
        tone = "alarm";
        h = `<p class="ask">Alarme ${U.esc(zone)}</p>
          <button class="big alarm" data-act="call">${Icons.ui("phone")}Appeler l'usine</button>`;
        break;
      case "CHECKING":
        tone = "amber";
        h = `<p class="ask">Vrai feu ou fausse alarme ?</p>
          <div class="pair"><button class="big alarm" data-act="real">${Icons.ui("fire")}Vrai feu</button>
          <button class="big ghost" data-act="false">Fausse alarme</button></div>`;
        break;
      case "CONFIRMED":
      case "EN_ROUTE":
        tone = "entry";
        h = `<p class="ask">Porte d'entrée du drone</p>
          <div class="doors" role="radiogroup" aria-label="Porte d'entrée du drone">${this.f.exits.map(e =>
            `<button role="radio" aria-checked="${e.id === this.entry}" data-exit="${e.id}" class="${e.id === this.entry ? "sel" : ""}">
              <b>${e.id}</b>${e.name ? `<small>${U.esc(e.name.replace(/^Sortie /, ""))}</small>` : ""}${e.id === reco ? "<em>Conseillée</em>" : ""}</button>`).join("")}</div>
          <button class="big entry" data-act="launch">${Icons.ui("drone")}Lancer le drone par ${this.entry || "?"}</button>`;
        break;
    }
    card.dataset.tone = tone;
    box.innerHTML = h;
    box.querySelectorAll("[data-exit]").forEach(b => b.onclick = () => this.pickEntry(b.dataset.exit));
    box.querySelectorAll("[data-act]").forEach(b => b.onclick = () => this._act(b.dataset.act));
  },

  pickEntry(id) {
    this.entry = id;
    this.keys.action = null;
    if (Live.s) this._action(Live.s);
  },

  async _act(a) {
    if (a === "call") await Live.post("/api/call_factory");
    if (a === "real") await Live.post("/api/factory/confirm", { real: true });
    if (a === "false") await Live.post("/api/factory/confirm", { real: false });
    if (a === "launch") await Live.post("/api/drone/launch", { entry: this.entry });
  },

  // trace des décisions : une ligne par décision, la plus récente en haut, l'heure d'abord
  _decisions(s) {
    const m = s.marks || {}, since = m.ALERT || 0, lines = [];
    const add = (t, text, cls = "") => { if (t && t >= since) lines.push({ t, text, cls }); };
    const al = this.lastAlarm;
    if (al) add(m.ALERT, `Alarme ${al.zone} ${this.zoneName[al.zone] || ""}, ${CAUSE_FR[al.cause] || al.cause}, capteur ${al.node}`, "alarm");
    add(m.CHECKING, "Usine appelée");
    if (m.FALSE_ALARM && m.FALSE_ALARM >= since && (!m.CONFIRMED || m.FALSE_ALARM > m.CONFIRMED)) add(m.FALSE_ALARM, "Fausse alarme confirmée");
    add(m.CONFIRMED, "Vrai feu confirmé");
    if (m.DRONE_INSIDE) {
      const t0 = (s.trail || [])[0];
      let door = t0 && MainMap && MainMap.nearestExit(t0[0], t0[1]);
      door = door ? door.id : ((s.events || []).map(e => (e.text.match(/sortie (E\d+)/) || [])[1]).filter(Boolean).pop() || "");
      add(m.DRONE_INSIDE, `Drone lancé${door ? " par " + door : ""}`);
    }
    if (s.phase === "PLANS_READY" && !this.plansLine) this.plansLine = this._plansSummary(s);
    if (m.PLANS_READY && this.plansLine && s.phase === "PLANS_READY") add(m.PLANS_READY, this.plansLine);
    for (const e of s.events || []) {
      if (e.kind !== "decision" || e.at < since) continue;
      const mm = e.text.match(/(V\d+)\D+«\s*(\w+)\s*»/);
      if (mm) add(e.at, `${mm[1]} : ${STATUS_LOWER[mm[2]] || mm[2]}, précisé par le commandant`);
    }
    lines.sort((a, b) => b.t - a.t);
    const html = lines.length
      ? lines.map((l, i) => `<li class="${l.cls}${i === 0 ? " latest" : ""}"><span class="t">${hhmmss(l.t)}</span><span class="x">${U.esc(l.text)}</span></li>`).join("")
      : `<li class="empty">${s.phase === "FALSE_ALARM" ? "Fausse alarme confirmée" : "Aucune alarme. Les capteurs surveillent l'usine."}</li>`;
    const ol = document.getElementById("decisions");
    if (ol.innerHTML !== html) ol.innerHTML = html;
  },

  _plansSummary(s) {
    const p = s.plans || {};
    const parts = ["évacuation"];
    if (p.entry && p.entry.door) parts.push(`entrée ${p.entry.door}`);
    const ex = (p.extinguish || [])[0];
    if (ex) parts.push(`extinction ${AGENT_FR[ex.agent] || ex.agent} ${FROM_FR[ex.attack_from] || ""}`.trim());
    return `Plans prêts : ${parts.join(", ")}`;
  },

  // victimes : une ligne par personne ; phrase du drone et boutons au dépliage
  _victims(s) {
    const found = (s.victims || []).filter(v => v.found);
    const key = JSON.stringify([found, s.dialogs, [...this.expanded]]);
    if (this.keys.victims === key) return;
    this.keys.victims = key;
    document.getElementById("victimCount").textContent = found.length;
    const ul = document.getElementById("victims");
    if (!this.knownVictims || !found.length) this.knownVictims = new Set(found.map(v => v.id));
    if (!found.length) { ul.innerHTML = '<li class="empty">Aucune victime détectée pour l\'instant.</li>'; return; }
    const rank = v => v.status === "injured" ? 0 : v.status === "no_answer" ? 1 : v.status ? 3 : 2;
    found.sort((a, b) => rank(a) - rank(b));
    ul.innerHTML = found.map(v => {
      const isNew = !this.knownVictims.has(v.id);
      const open = this.expanded.has(v.id);
      const last = (s.dialogs[v.id] || []).slice(-1)[0];
      const z = Panel._zoneOf(v.x, v.y);
      const word = v.status ? STATUS_FR[v.status] : "État inconnu";
      const btn = (st, label) => `<button data-v="${v.id}" data-s="${st}" aria-pressed="${v.status === st}">${label}</button>`;
      return `<li class="v${isNew ? " new" : ""}">
        <button class="vrow" data-v="${v.id}" aria-expanded="${open}" aria-controls="vd-${v.id}">${Icons.ui("chevron", "chev")}${statusShape(v.status)}
          <span class="id">${v.id}</span><span class="zn">${z ? U.esc(z.name) : ""}</span>
          <span class="st${v.status !== "walking" ? " prio" : ""}">${word}</span></button>
        <div class="vdet" id="vd-${v.id}" ${open ? "" : "hidden"}>
          ${last ? `<p class="msg">Drone : ${U.esc(last.text)}</p>` : ""}
          <div class="vb">${btn("walking", "Marche")}${btn("injured", "Blessé(e)")}${btn("no_answer", "Sans réponse")}</div></div></li>`;
    }).join("");
    for (const v of found) this.knownVictims.add(v.id);
  },

  _zoneOf(x, y) {
    for (const z of this.f.zones || []) {
      const [x0, y0, x1, y1] = z.rect;
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return z;
    }
    return null;
  },

  // plans : lecture seule ; le détail du test à 3 minutes est replié par défaut
  _plans(s) {
    const p = s.plans || {};
    const key = JSON.stringify([p, s.phase, (s.victims || []).map(v => v.status), [...this.lookOpen]]);
    if (this.keys.plans === key) return;
    this.keys.plans = key;
    const box = document.getElementById("plans");
    const ev = p.evacuation || [], en = p.entry, ex = p.extinguish || [];
    if (!ev.length && !en && !ex.length) {
      box.innerHTML = '<p class="empty">Les plans apparaissent quand le drone a trouvé des victimes.</p>'; return;
    }
    const statusOf = Object.fromEntries((s.victims || []).map(v => [v.id, v.status]));
    const anyFound = (s.victims || []).some(v => v.found);
    const evSorted = [...ev].sort((a, b) => (b.rescue_first ? 1 : 0) - (a.rescue_first ? 1 : 0));
    let h = "";
    h += `<div class="plan"><div class="plan-h"><i class="key evac"></i>Évacuation</div><ul>${evSorted.map(e =>
      `<li>${statusShape(statusOf[e.victim])}<b>${e.victim}</b><span>${e.exit ? `sortie ${e.exit}` : "aucun chemin sûr"}</span>
        ${e.rescue_first ? '<span class="prio">en premier</span>' : ""}<span class="r">${e.path && e.path.length ? `${e.path.length - 1} m` : ""}</span></li>`).join("")
      || '<li class="empty">Aucune victime trouvée</li>'}</ul></div>`;
    h += `<div class="plan"><div class="plan-h"><i class="key entry"></i>Entrée des pompiers</div><ul>${en
      ? `<li><span>Par <b>${en.door}</b>, ${anyFound ? "vers les victimes" : "jusqu'au feu"}</span>
         <span class="r">${en.path && en.path.length ? `${en.path.length - 1} m` : ""}</span></li>`
      : '<li class="empty">Aucune porte conseillée</li>'}</ul></div>`;
    h += `<div class="plan"><div class="plan-h"><i class="key attack"></i>Extinction</div><ul>${ex.map(e => {
      const l = e.lookahead, open = this.lookOpen.has(e.zone);
      return `<li class="ext"><span class="ord">${e.order}</span>
        <span><b>${e.zone} ${U.esc(this.zoneName[e.zone] || "")}</b>, ${U.esc(AGENT_FR[e.agent] || e.agent)} ${U.esc(SIDE_FR[e.attack_from] || e.attack_from)}</span>
        ${(e.first || []).length ? `<span class="first">D'abord : ${U.esc(e.first.map(firstFr).join(", "))}</span>` : ""}
        ${l ? `<button class="more" data-z="${e.zone}" aria-expanded="${open}">${open ? "Masquer le test" : "Voir le test à 3 min"}</button>
        <span class="look" ${open ? "" : "hidden"}>${U.esc(FIRE_CLASS_FR[e.fire_class] || e.fire_class)}. Simulé ${l.minutes} min à l'avance : feu près des victimes ${l.fire_near_victims.no_action} puis ${l.fire_near_victims.with_attack} m², feu total ${l.fire_m2.no_action} puis ${l.fire_m2.with_attack} m² (sans action, puis avec cette attaque).</span>` : ""}</li>`;
    }).join("") || '<li class="empty">Aucun foyer actif</li>'}</ul></div>`;
    box.innerHTML = h;
  },

  _log(s) {
    const ul = document.getElementById("log");
    const evs = s.events || [];
    if (evs.length && evs[evs.length - 1].at < this.lastEventAt) { ul.innerHTML = ""; this.lastEventAt = 0; }   // reset
    let added = false;
    for (const e of evs) {
      if (e.at <= this.lastEventAt) continue;
      ul.prepend(U.el("li", "", `<span class="t">${e.t}</span><span class="${e.kind}">${U.esc(stripEmoji(e.text))}</span>`));
      this.lastEventAt = e.at;
      added = true;
    }
    if (added) {
      for (const li of ul.querySelectorAll("li.latest")) li.classList.remove("latest");
      if (ul.firstChild) ul.firstChild.classList.add("latest");
    }
    while (ul.children.length > 80) ul.lastChild.remove();
  },

  // état des modules : visible au survol / focus de l'indicateur de liaison
  _health(s) {
    const h = s.health || {};
    const names = new Set(["vision", "voix", ...Object.keys(h)]);
    if (![...names].some(n => n.startsWith("capteur"))) names.add("capteur N1");
    const html = [`<span class="${s.sim_kind === "real" ? "" : "off"}">Simulation ${s.sim_kind === "real" ? "réelle" : "de secours"}</span>`,
      ...[...names].sort().map(n => {
        const age = h[n];
        const on = age != null && age < 5;
        const label = U.esc(n.charAt(0).toUpperCase() + n.slice(1));
        return `<span class="${on ? "" : "off"}">${label}${age != null ? ` ${age < 60 ? age.toFixed(0) + " s" : "hors ligne"}` : ", jamais vu"}</span>`;
      })].join("");
    const el = document.getElementById("health");
    if (el.innerHTML !== html) el.innerHTML = html;
  },

  _beep() {
    try {
      const ac = this.ac || (this.ac = new (window.AudioContext || window.webkitAudioContext)());
      [0, .35, .7].forEach(t0 => {
        const o = ac.createOscillator(), g = ac.createGain();
        o.frequency.value = 880; o.type = "square";
        g.gain.setValueAtTime(0.0001, ac.currentTime + t0);
        g.gain.exponentialRampToValueAtTime(0.15, ac.currentTime + t0 + .02);
        g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + t0 + .25);
        o.connect(g).connect(ac.destination); o.start(ac.currentTime + t0); o.stop(ac.currentTime + t0 + .3);
      });
    } catch (e) { /* le navigateur bloque le son tant qu'on n'a pas cliqué */ }
  },
};
