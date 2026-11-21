// panel.js — tout ce qui n'est pas la carte : frise des phases, chrono, LIVE, actions,
// drone, victimes, plans (à valider par le commandant), journal, santé des modules, vent.
"use strict";

const PHASE_FR = {
  NORMAL: "Surveillance", ALERT: "Alerte", CHECKING: "Levée de doute", CONFIRMED: "Confirmé",
  EN_ROUTE: "En route", DRONE_INSIDE: "Drone dedans", PLANS_READY: "Plans prêts",
};
const PHASES = Object.keys(PHASE_FR);
const STATUS_FR = { walking: "peut marcher", injured: "blessé(e)", no_answer: "ne répond pas" };
const FIRE_CLASS_FR = { A: "classe A (solides)", B: "classe B (liquides)", C: "classe C (gaz)", E: "électrique", electrical: "électrique" };
const AGENT_FR = { water: "eau", foam: "mousse", powder: "poudre", CO2: "CO₂" };
const SIDE_FR = { N: "par le nord", S: "par le sud", E: "par l'est", W: "par l'ouest" };
const firstFr = (a) => a.replace("close the gas valve", "fermer la vanne gaz").replace("cut the power", "couper le courant");
const WIND_DIRS = [0, 45, 90, 135, 180, 225, 270, 315];
// WIND_DIRS = angle de la flèche à l'écran (0 = vers l'est, sens horaire).
// Contrat de la Sim : deg = direction VERS laquelle souffle le vent, 0 = nord, 90 = est.
const windToSim = (screenDeg) => (screenDeg + 90) % 360;
const windFromSim = (simDeg) => ((Math.round(simDeg) - 90) % 360 + 360) % 360;

const Panel = {
  entry: null, lastPhase: null, lastEventAt: 0, keys: {}, walkable: 1, windIdx: 0, windBusy: 0,

  init(f) {
    this.f = f;
    this.zoneName = Object.fromEntries((f.zones || []).map(z => [z.id, z.name]));
    this.walkable = f.grid.join("").split("").filter(c => c !== "#").length;
    const st = document.getElementById("stepper");
    st.innerHTML = PHASES.map(p => `<li data-p="${p}">${PHASE_FR[p]}</li>`).join("");
    // vent
    const kmh = document.getElementById("windKmh");
    kmh.oninput = () => { document.getElementById("windKmhTxt").textContent = kmh.value + " km/h"; this.windBusy = performance.now(); };
    kmh.onchange = () => this.sendWind();
    document.getElementById("windDir").onclick = () => { this.windIdx = (this.windIdx + 1) % 8; this.windBusy = performance.now(); this.sendWind(); this._windArrow(); };
  },

  sendWind() {
    Live.post("/api/wind", { kmh: +document.getElementById("windKmh").value, deg: windToSim(WIND_DIRS[this.windIdx]) });
  },
  _windArrow() {
    document.getElementById("windDir").style.transform = `rotate(${WIND_DIRS[this.windIdx]}deg)`;
  },

  // ----------------------------------------------------------- à chaque état
  onState(s) {
    this._stepper(s);
    this._banner(s);
    this._action(s);
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
    // LIVE
    const lag = (performance.now() - Live.at) / 1000;
    const live = document.getElementById("live");
    live.classList.toggle("stale", !Live.ok || lag > 2);
    live.querySelector(".txt").textContent = (!Live.ok || lag > 2) ? "CONNEXION ?" : `LIVE · ${lag.toFixed(1).replace(".", ",")} s`;
    // chrono depuis l'alarme
    const ch = document.getElementById("chrono");
    const a = s.marks && s.marks.ALERT;
    if (a && s.phase !== "NORMAL" && s.phase !== "FALSE_ALARM") {
      const sec = Math.max(0, Live.serverNow() - a);
      ch.textContent = `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
      ch.classList.add("on");
    } else { ch.textContent = "--:--"; ch.classList.remove("on"); }
    // drone
    const d = s.drone;
    const st = document.getElementById("droneState");
    const temp = d ? Tween.get("droneTemp", d.temp, 0.08) : null;
    document.getElementById("droneTemp").textContent = d ? Math.round(temp) : "--";
    document.getElementById("droneBar").style.width = d ? U.clamp((temp - 20) / 60 * 100, 0, 100) + "%" : "0";
    const stateFr = { EXPLORING: "EXPLORATION", RETURNING: "RETOUR", OUT: "SORTI" };
    st.textContent = d ? stateFr[d.state] || d.state : "AU SOL";
    st.style.background = d && d.state === "RETURNING" ? "#5a1a12" : d && d.state === "EXPLORING" ? "#0b2a4a" : "";
    const pct = Math.round(100 * Live.revealAt.size / this.walkable);
    document.getElementById("droneMini").textContent = d ? `exploré ${Math.min(100, pct)} % · ${(s.trail || []).length} m parcourus` : "en attente de lancement";
  },

  _stepper(s) {
    const idx = PHASES.indexOf(s.phase);
    for (const li of document.querySelectorAll("#stepper li")) {
      const i = PHASES.indexOf(li.dataset.p);
      li.className = "";
      if (s.phase === "FALSE_ALARM") {
        if (li.dataset.p === "CHECKING") li.className = "false";
        else if (i < 2) li.className = "done";
        continue;
      }
      if (i < idx) li.className = "done";
      if (i === idx) li.className = "now" + (["NORMAL", "PLANS_READY"].includes(s.phase) ? " calm" : "");
    }
  },

  _banner(s) {
    const b = document.getElementById("banner");
    let txt = "", cls = "";
    const d = s.drone;
    if (s.phase === "ALERT" && s.alarm) { txt = `🚨 ALARME zone ${s.alarm.zone} · ${s.alarm.cause} · capteur ${s.alarm.node}`; cls = "red"; }
    else if (s.phase === "CHECKING") { txt = "📞 Appel de l'usine en cours : vrai feu ou fausse alarme ?"; cls = "yellow"; }
    else if (s.phase === "FALSE_ALARM") { txt = "✔ Fausse alarme confirmée par l'usine"; cls = "yellow"; }
    else if (s.phase === "EN_ROUTE") { txt = "🚒 En route · en rouge transparent : le feu prévu dans 3 min"; cls = "blue"; }
    else if (s.phase === "DRONE_INSIDE" && d && d.state === "RETURNING" && d.temp >= 55) { txt = `🌡 Drone à ${Math.round(d.temp)} °C · retour automatique`; cls = "red"; }
    else if (s.phase === "DRONE_INSIDE") { txt = "🚁 Cartographie en cours · la carte se découvre autour du drone"; cls = "blue"; }
    else if (s.phase === "PLANS_READY") { txt = "📋 Plans prêts : à valider par le commandant"; cls = "green"; }
    b.textContent = txt;
    b.className = "banner " + cls + (txt ? " show" : "");
  },

  _recommendedExit(s) {
    const fire = (s.fire || []);
    if (!fire.length) return (this.f.exits[0] || {}).id;
    let best = null;
    for (const e of this.f.exits) {
      let dmin = Infinity;
      for (const [x, y] of fire) dmin = Math.min(dmin, Math.abs(x - e.x) + Math.abs(y - e.y));
      // assez loin du feu pour entrer, mais pas à l'autre bout du bâtiment
      const score = dmin < 6 ? 1e9 : dmin;
      if (!best || score < best.score) best = { id: e.id, score };
    }
    return best.id;
  },

  _action(s) {
    const card = document.getElementById("cardAction");
    const reco = s.phase === "EN_ROUTE" ? this._recommendedExit(s) : null;
    if (s.phase === "EN_ROUTE" && !this.entry) this.entry = reco;
    if (s.phase !== "EN_ROUTE") this.entry = null;
    const key = [s.phase, this.entry, reco, s.alarm && s.alarm.at].join("|");
    if (this.keys.action === key) return;
    this.keys.action = key;
    const z = s.alarm ? `${s.alarm.zone} · ${this.zoneName[s.alarm.zone] || ""}` : "";
    let h = "";
    switch (s.phase) {
      case "NORMAL":
        h = `<div class="action-title">✅ Surveillance active</div>
          <div class="action-sub">${(this.f.sensors || []).length} capteurs fixes dans l'usine « ${U.esc(this.f.name || "")} ». En attente d'une alarme.</div>`;
        break;
      case "ALERT":
        h = `<div class="action-title" style="color:var(--red)">🚨 Alarme : ${U.esc(z)}</div>
          <div class="action-sub">Cause : ${U.esc(s.alarm.cause)} · gaz ${s.alarm.gas ?? "-"} · ${s.alarm.temp ?? "-"} °C. Lever le doute avant de partir.</div>
          <button class="btn red pulse" data-act="call">📞 Appeler l'usine</button>`;
        break;
      case "CHECKING":
        h = `<div class="action-title">📞 L'usine est appelée…</div>
          <div class="action-sub">L'usine répond sur <a href="/factory" target="_blank" style="color:var(--cyan)">/factory</a>. Si elle répond au téléphone, saisir sa réponse ici :</div>
          <div class="row"><button class="btn red" data-act="real">🔥 Vrai feu</button>
          <button class="btn" data-act="false">Fausse alarme</button></div>`;
        break;
      case "FALSE_ALARM":
        h = `<div class="action-title">✔ Fausse alarme</div><div class="action-sub">Intervention annulée, enregistrée dans le journal.</div>`;
        break;
      case "CONFIRMED":
      case "EN_ROUTE":
        h = `<div class="action-title">🚒 En route vers ${U.esc(z || "l'usine")}</div>
          <div class="action-sub">Choisir la sortie par laquelle le drone entre (ou cliquer une sortie sur la carte).</div>
          <div class="exits">${this.f.exits.map(e => `<button data-exit="${e.id}" class="${e.id === this.entry ? "sel" : ""}">${e.id}
            ${e.name ? `<small class="muted">${U.esc(e.name.replace(/^Sortie /, ""))}</small>` : ""}${e.id === reco ? "<em>recommandée</em>" : ""}</button>`).join("")}</div>
          <button class="btn blue pulse" data-act="launch">🚁 Lancer le drone par ${this.entry}</button>`;
        break;
      case "DRONE_INSIDE":
        h = `<div class="action-title">🚁 Drone à l'intérieur</div>
          <div class="action-sub">Il explore, détecte les victimes et leur parle. Les zones dangereuses s'ouvrent en loupe automatiquement. Cliquer une zone pour la voir en détail.</div>`;
        break;
      case "PLANS_READY":
        h = `<div class="action-title" style="color:var(--green)">📋 Bâtiment scanné</div>
          <div class="action-sub">Les trois plans sont prêts plus bas. L'IA recommande, le commandant décide.</div>`;
        break;
    }
    card.innerHTML = h;
    card.querySelectorAll("[data-exit]").forEach(b => b.onclick = () => this.pickEntry(b.dataset.exit));
    card.querySelectorAll("[data-act]").forEach(b => b.onclick = () => this._act(b.dataset.act));
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

  _victims(s) {
    const found = (s.victims || []).filter(v => v.found);
    const key = JSON.stringify([found, s.dialogs]);
    if (this.keys.victims === key) return;
    this.keys.victims = key;
    document.getElementById("victimCount").textContent = found.length;
    const ul = document.getElementById("victims");
    if (!found.length) { ul.innerHTML = '<li class="muted">Aucune victime détectée pour l\'instant.</li>'; return; }
    // les plus urgentes en premier
    const rank = v => v.status === "injured" ? 0 : v.status === "no_answer" ? 1 : v.status ? 3 : 2;
    found.sort((a, b) => rank(a) - rank(b));
    ul.innerHTML = found.map(v => {
      const dl = (s.dialogs[v.id] || []).slice(-2).map(m =>
        `<div class="bubble ${m.who === "drone" ? "" : "me"}">${m.who === "drone" ? "🔊" : "🎙"} ${U.esc(m.text.length > 110 ? m.text.slice(0, 110) + "…" : m.text)}</div>`).join("");
      // le drone parle sans écouter : état inconnu tant que le commandant ne le précise pas
      const st = v.status ? STATUS_FR[v.status] : "état inconnu";
      const col = v.status === "walking" ? "var(--green)" : v.status ? "var(--red)" : "var(--muted)";
      const z = Panel._zoneOf(v.x, v.y);
      return `<li class="v ${v.status || ""}"><div class="vh"><b>${v.id}</b><small class="muted">${z ? U.esc(z.id + " " + z.name) : ""}</small>
        <span class="st" style="color:${col}">${st}${v.status !== "walking" ? " · SECOURIR EN 1er" : ""}</span></div>${dl}
        <div class="vb"><button class="btn small ghost" data-v="${v.id}" data-s="walking">🚶 marche</button>
        <button class="btn small ghost" data-v="${v.id}" data-s="injured">🤕 blessé</button>
        <button class="btn small ghost" data-v="${v.id}" data-s="no_answer">❓ pas de réponse</button></div></li>`;
    }).join("");
    ul.querySelectorAll("[data-v]").forEach(b => b.onclick = () => Live.post("/api/victim/status", { victim: b.dataset.v, status: b.dataset.s }));
  },

  _zoneOf(x, y) {
    for (const z of this.f.zones || []) {
      const [x0, y0, x1, y1] = z.rect;
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return z;
    }
    return null;
  },

  _plans(s) {
    const p = s.plans || {};
    const key = JSON.stringify([p, s.decisions, s.phase]);
    if (this.keys.plans === key) return;
    this.keys.plans = key;
    const box = document.getElementById("plans");
    const ev = p.evacuation || [], en = p.entry, ex = p.extinguish || [];
    if (!ev.length && !en && !ex.length) {
      box.innerHTML = '<p class="muted">Les plans apparaissent quand le drone a trouvé des victimes.</p>'; return;
    }
    const dec = (name) => {
      const d = (s.decisions || {})[name];
      const badge = d ? `<span class="dec ${d.decision === "accepted" ? "ok" : "ko"}">${d.decision === "accepted" ? "✔ validé" : "✖ rejeté"} ${d.t}</span>` : `<span class="dec muted">à valider</span>`;
      return badge;
    };
    const btns = (name) => `<div class="row"><button class="btn small green" data-plan="${name}" data-d="accepted">✔ Valider</button>
      <button class="btn small" data-plan="${name}" data-d="rejected">✖ Rejeter</button></div>`;
    const evSorted = [...ev].sort((a, b) => (b.rescue_first ? 1 : 0) - (a.rescue_first ? 1 : 0));
    let h = "";
    h += `<div class="plan"><div class="plan-h">🟢 1. Évacuation ${dec("evacuation")}</div><ul>${evSorted.map(e =>
      `<li><b>${e.victim}</b> → sortie <b>${e.exit || "?"}</b>${e.path && e.path.length ? `, ${e.path.length - 1} m` : ", aucun chemin sûr"}${e.rescue_first ? ' · <b style="color:var(--red)">SECOURIR EN PREMIER</b>' : " · peut sortir guidé"}</li>`).join("") || "<li>—</li>"}</ul>${btns("evacuation")}</div>`;
    h += `<div class="plan"><div class="plan-h">🔵 2. Entrée des pompiers ${dec("entry")}</div><ul>${en ?
      `<li>Entrer par <b>${en.door}</b> : chemin le plus sûr vers les victimes${en.path ? ` (${en.path.length - 1} m jusqu'à la 1re victime)` : ""}</li>` : "<li>—</li>"}</ul>${btns("entry")}</div>`;
    const look = (e) => {
      const l = e.lookahead; if (!l) return "";
      return `<br><small class="muted">testé ${l.minutes} min à l'avance : feu près des victimes ${l.fire_near_victims.no_action} → ${l.fire_near_victims.with_attack} m², `
        + `feu total ${l.fire_m2.no_action} → ${l.fire_m2.with_attack} m² (sans action → avec cette attaque)</small>`;
    };
    h += `<div class="plan"><div class="plan-h">🧯 3. Extinction ${dec("extinguish")}</div><ul>${ex.map(e =>
      `<li><b>${e.order}.</b> ${e.zone} ${U.esc(this.zoneName[e.zone] || "")} · ${FIRE_CLASS_FR[e.fire_class] || e.fire_class}`
      + `${(e.first || []).length ? ` · <b style="color:var(--red)">d'abord : ${U.esc(e.first.map(firstFr).join(", "))}</b>` : ""}`
      + ` · <b>${U.esc(AGENT_FR[e.agent] || e.agent)}</b> · attaquer ${U.esc(SIDE_FR[e.attack_from] || e.attack_from)}${look(e)}</li>`).join("") || "<li>Aucun foyer actif</li>"}</ul>${btns("extinguish")}</div>`;
    box.innerHTML = h;
    box.querySelectorAll("[data-plan]").forEach(b => b.onclick = () => Live.post("/api/plan/decide", { plan: b.dataset.plan, decision: b.dataset.d }));
  },

  _log(s) {
    const ul = document.getElementById("log");
    const evs = s.events || [];
    if (evs.length && evs[evs.length - 1].at < this.lastEventAt) { ul.innerHTML = ""; this.lastEventAt = 0; }   // reset
    for (const e of evs) {
      if (e.at <= this.lastEventAt) continue;
      const li = U.el("li", "new", `<span class="t">${e.t}</span><span class="${e.kind}">${U.esc(e.text)}</span>`);
      ul.prepend(li);
      this.lastEventAt = e.at;
    }
    while (ul.children.length > 80) ul.lastChild.remove();
  },

  _health(s) {
    const h = s.health || {};
    const names = new Set(["vision", "voix", ...Object.keys(h)]);
    if (![...names].some(n => n.startsWith("capteur"))) names.add("capteur N1");
    const html = [`<span class="${s.sim_kind === "real" ? "" : "off"}">sim ${s.sim_kind === "real" ? "réelle" : "FakeSim"}</span>`,
      ...[...names].sort().map(n => {
        const age = h[n];
        const on = age != null && age < 5;
        return `<span class="${on ? "" : "off"}">${n}${age != null ? ` · ${age < 60 ? age.toFixed(0) + " s" : "hors ligne"}` : " · jamais vu"}</span>`;
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
