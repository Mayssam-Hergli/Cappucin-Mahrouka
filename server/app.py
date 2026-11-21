"""Serveur hub Aeroday : API partagée + machine à phases + dashboard.

    pip install -r server/requirements.txt
    python server/app.py            # http://0.0.0.0:5000
    FAKE_SIM=1 python server/app.py # forcer la FakeSim même si sim/ existe

Pages : /  (dashboard Protection Civile)   /factory  (page usine)
"""
import copy
import json
import os
import sys
import threading
import time
import traceback

from urllib.parse import urlparse

from flask import Flask, jsonify, render_template, request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from fake_sim import FakeSim  # noqa: E402
from geo import Grid, compass_fr  # noqa: E402
from zones import Analyzer  # noqa: E402
import security  # noqa: E402
from security import SensorAuth, clean_jpg, clean_sensor, num  # noqa: E402

PHASES = ["NORMAL", "ALERT", "CHECKING", "CONFIRMED", "EN_ROUTE", "DRONE_INSIDE", "PLANS_READY"]
RUNNING = {"CONFIRMED", "EN_ROUTE", "DRONE_INSIDE", "PLANS_READY"}
STEP_S = 0.5


def factory_path():
    p = os.path.join(ROOT, "sim", "factory.json")
    return p if os.path.exists(p) else os.path.join(HERE, "data", "factory_demo.json")


def make_sim(path):
    """Vraie Sim de Teammate 2 si disponible, sinon FakeSim (même interface)."""
    if os.environ.get("FAKE_SIM") != "1":
        try:
            sys.path.insert(0, ROOT)
            from sim import Sim  # type: ignore
            return Sim(path), "real"
        except Exception as e:  # pas encore prête : on continue avec la FakeSim
            print(f"[hub] Sim réelle indisponible ({e.__class__.__name__}: {e}) -> FakeSim")
    return FakeSim(path), "fake"


class Hub:
    def __init__(self):
        self.lock = threading.RLock()
        self.speed = 1.0
        self.reset()

    # ------------------------------------------------------------- outils
    def reset(self):
        with self.lock:
            self.path = factory_path()
            with open(self.path, encoding="utf-8") as f:
                self.factory = json.load(f)
            # sim/factory.json a des noms anglais + "label_fr" / "name_fr" : le dashboard est en français
            for z in self.factory.get("zones", []):
                z["name"] = z.get("label_fr", z["name"])
            self.factory["name"] = self.factory.get("name_fr", self.factory.get("name", ""))
            self.grid = Grid(self.factory)
            self.sim, self.sim_kind = make_sim(self.path)
            w = (self.factory.get("demo") or {}).get("wind")
            if w:                                   # vent du scénario de démo (modifiable au curseur)
                self.sim.set_wind(w["kmh"], w["deg"])
            self.an = Analyzer(self.factory)
            self.phase = "NORMAL"
            self.phase_at = time.time()
            self.events = []
            self.alarm = None
            self.marks = {}            # horodatages clés (alarme, départ, drone…)
            self.real_sensors = {}
            self.health = {}
            self.voice_queue = []
            self.dialogs = {}
            self.camera = None
            self.last_vision_add = 0
            self.decisions = {}
            self.forecast = []
            self.ignore_alarm_until = 0
            self.known_found = set()
            self.drone_state = None
            self.sec_logged = {}
            self.last = self.sim.state() if self.sim_kind == "fake" else None
            self.log("Système prêt. Surveillance des capteurs de l'usine.")

    def security_log(self, text):
        """Refus de sécurité dans le journal, au plus une fois toutes les 10 s par message."""
        now = time.time()
        if now - self.sec_logged.get(text, 0) >= 10:
            self.sec_logged[text] = now
            self.log(text, "warn")
        print("[sécurité]", text)

    def log(self, text, kind="info"):
        self.events.append({"t": time.strftime("%H:%M:%S"), "at": time.time(),
                            "text": text, "kind": kind})
        self.events = self.events[-120:]

    def set_phase(self, p, text=None, kind="phase"):
        self.phase = p
        self.phase_at = time.time()
        self.marks[p] = self.phase_at
        if text:
            self.log(text, kind)

    # --------------------------------------------------------------- boucle
    def tick(self):
        now = time.time()
        with self.lock:
            st = None
            if self.phase in RUNNING:
                self.sim.step()
                st = self.sim.state()
                self.last = st
            for kind, txt in self.an.update(st, now, self.real_sensors):
                self.log(txt, kind)
            if st:
                self._watch_victims(st)
                self._watch_drone(st)
            if self.phase == "FALSE_ALARM" and now - self.phase_at > 4:
                self.set_phase("NORMAL", "Retour en surveillance normale.")

    def _watch_victims(self, st):
        for v in st.get("victims", []):
            if v.get("found") and v["id"] not in self.known_found:
                self.known_found.add(v["id"])
                z = self.grid.zone_of(v["x"], v["y"])
                self.log(f"Victime {v['id']} détectée par caméra thermique ({z}, x={v['x']} y={v['y']})",
                         "victim")
                say = self._message_for(v, st)
                self.voice_queue.append({"victim": v["id"], "say": say})
                self.dialogs.setdefault(v["id"], []).append({"who": "drone", "text": say,
                                                             "t": time.strftime("%H:%M:%S")})

    def _message_for(self, v, st):
        if hasattr(self.sim, "guidance"):        # vraie Sim : sortie la plus sûre, distance, portes
            try:
                return self.sim.guidance(v["id"])["say"]
            except Exception as e:
                print("[hub] guidance indisponible :", e)
        exit_id = None
        for e in (st.get("plans") or {}).get("evacuation", []) or []:
            if e.get("victim") == v["id"]:
                exit_id = e.get("exit")
        best = None
        for e in self.grid.exits:
            d = abs(e["x"] - v["x"]) + abs(e["y"] - v["y"])
            if (exit_id and e["id"] == exit_id) or (not exit_id and (best is None or d < best[0])):
                best = (d, e)
        d, e = best
        return ("Bonjour, je suis le drone de la Protection Civile. Restez calme. "
                f"La sortie la plus proche est la sortie {e['id']}, {compass_fr(e['x'] - v['x'], e['y'] - v['y'])}, "
                f"à environ {d} mètres. Restez près du sol. La Protection Civile est en route.")

    def _watch_drone(self, st):
        d = st.get("drone")
        if not d:
            return
        s = d.get("state")
        if s != self.drone_state:
            if s == "RETURNING":
                if d.get("temp", 0) >= 60:
                    self.log(f"Drone à {d['temp']:.0f} °C : retour automatique vers la sortie la plus proche",
                             "danger")
                else:
                    self.log("Exploration terminée : le drone revient", "info")
            elif s == "OUT":
                self.log("Drone sorti du bâtiment", "info")
                if self.phase == "DRONE_INSIDE":
                    self.set_phase("PLANS_READY", "Les 3 plans sont prêts : évacuation, entrée, extinction. "
                                                  "À valider par le commandant.")
            self.drone_state = s

    def loop(self):
        while True:
            t0 = time.time()
            try:
                self.tick()
            except Exception:
                traceback.print_exc()
            time.sleep(max(0.02, STEP_S / self.speed - (time.time() - t0)))

    # ---------------------------------------------------- actions (API)
    def sensor(self, d):
        node = d.get("node", "N?")
        now = time.time()
        with self.lock:
            d = dict(d, at=now)
            prev = self.real_sensors.get(node, {})
            self.real_sensors[node] = d
            self.health["capteur " + node] = now
            lvl = d.get("level", "NORMAL")
            zone = d.get("zone") or next((s["zone"] for s in self.factory.get("sensors", [])
                                          if s["id"] == node), "?")
            if lvl == "ALARM" and self.phase == "NORMAL" and now > self.ignore_alarm_until:
                self.alarm = {"node": node, "zone": zone, "cause": d.get("cause", "?"), "at": now,
                              "temp": d.get("temp"), "gas": d.get("gas")}
                self.set_phase("ALERT", f"ALARME zone {zone} ({d.get('cause', '?')}) — capteur {node}",
                               "danger")
            elif lvl == "WARNING" and prev.get("level", "NORMAL") == "NORMAL":
                self.log(f"Pré-alerte capteur {node} zone {zone} ({d.get('cause', '?')})", "warn")

    def fake_alarm(self):
        s = (self.factory.get("sensors") or [{"id": "N1", "zone": "Z1"}])[0]
        with self.lock:
            if self.phase == "FALSE_ALARM":
                self.phase = "NORMAL"
            self.ignore_alarm_until = 0
            self.sensor({"node": s["id"], "zone": s["zone"], "gas": 1900, "temp": 41, "flame": 0,
                         "level": "ALARM", "cause": "gas"})

    def call_factory(self):
        with self.lock:
            if self.phase == "ALERT":
                self.set_phase("CHECKING", "Appel de l'usine pour lever le doute…")

    def confirm(self, real, origin=None):
        with self.lock:
            if self.phase not in ("ALERT", "CHECKING"):
                return False
            if not real:
                self.set_phase("FALSE_ALARM", "FAUSSE ALARME confirmée par l'usine. Intervention annulée.",
                               "warn")
                self.alarm = None
                self.ignore_alarm_until = time.time() + 20
                return True
            if not origin and self.alarm:
                s = next((s for s in self.factory.get("sensors", []) if s["id"] == self.alarm["node"]), None)
                origin = [s["x"], s["y"]] if s else None
            ox, oy = (int(v) for v in (origin or [self.grid.W // 2, self.grid.H // 2]))
            self.sim.start_fire(ox, oy)
            self.set_phase("CONFIRMED", f"L'usine CONFIRME l'incendie. Départ du feu : "
                                        f"{self.grid.zone_of(ox, oy)} (x={ox}, y={oy})", "danger")
            self.set_phase("EN_ROUTE", "Équipe en route. Plan de l'usine et prévision du feu chargés.")
            self.start_forecast()
            return True

    def launch(self, entry):
        with self.lock:
            if self.phase != "EN_ROUTE":
                return False
            self.sim.launch_drone(entry)
            self.set_phase("DRONE_INSIDE", f"Drone lancé par la sortie {entry}. Cartographie en cours.")
            return True

    def skip(self):
        """Passe à l'étape suivante du scénario (démo)."""
        with self.lock:
            p = self.phase
            if p in ("NORMAL", "FALSE_ALARM"):
                self.fake_alarm()
            elif p == "ALERT":
                self.call_factory()
            elif p == "CHECKING":
                self.confirm(True)
            elif p == "EN_ROUTE":
                self.launch(self.grid.exits[-1]["id"])
            elif p == "DRONE_INSIDE" and getattr(self.sim, "drone", None):
                self.heat_drone(to=61)

    def heat_drone(self, delta=0.0, to=None):
        """Réchauffe le drone (boutons démo). Vraie Sim : sim.heat_drone() ; FakeSim : son dict."""
        d = self.sim.drone
        if hasattr(self.sim, "heat_drone"):
            current = self.sim.state()["drone"]["temp"]
            self.sim.heat_drone((to - current) if to is not None else delta)
        else:
            d["temp"] = to if to is not None else d["temp"] + delta

    # ------------------------------------------------------------ prévision
    def start_forecast(self):
        def run():
            try:
                if hasattr(self.sim, "forecast"):     # vraie Sim : prévision sur une copie interne
                    fire = self.sim.forecast(3)["fire"]
                else:                                 # FakeSim : pas de 0,5 s
                    with self.lock:
                        s = copy.deepcopy(self.sim)
                    for _ in range(360):          # 3 min simulées
                        s.step()
                    fire = s.state().get("fire", [])
                with self.lock:
                    self.forecast = fire
                    self.log("Prévision du feu à +3 min calculée", "info")
            except Exception as e:
                print("[hub] prévision impossible :", e)
        threading.Thread(target=run, daemon=True).start()

    # ----------------------------------------------------------------- état
    def full_state(self):
        now = time.time()
        with self.lock:
            st = dict(self.last or {})
            st.update(self.an.snapshot(now))
            st.update({
                "phase": self.phase,
                "phase_at": self.phase_at,
                "server_time": now,
                "events": self.events[-60:],
                "alarm": self.alarm,
                "marks": self.marks,
                "health": {k: round(now - v, 1) for k, v in self.health.items()},
                "dialogs": self.dialogs,
                "camera": self.camera,
                "decisions": self.decisions,
                "forecast": self.forecast if self.phase == "EN_ROUTE" else [],
                "speed": self.speed,
                "sim_kind": self.sim_kind,
            })
            if not st.get("plans"):
                st["plans"] = {"evacuation": [], "entry": None, "extinguish": []}
            return st


hub = Hub()
app = Flask(__name__, template_folder="templates", static_folder="static")
app.json.ensure_ascii = False
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024      # une image caméra fait ~40 Ko
auth = SensorAuth()


@app.before_request
def post_guard():
    """Contre les requêtes envoyées par une autre page web (CSRF) : POST en JSON seulement,
    et si le navigateur indique son origine, ce doit être ce serveur."""
    if request.method != "POST":
        return None
    if request.mimetype != "application/json":
        return jsonify(ok=False, error="Content-Type: application/json attendu"), 415
    origin = request.headers.get("Origin")
    if origin and urlparse(origin).netloc != request.host:
        return jsonify(ok=False, error="origine refusée"), 403
    return None


def body():
    d = request.get_json(silent=True)
    return d if isinstance(d, dict) else {}


def bad(msg):
    return jsonify(ok=False, error=msg), 400


# ---------------------------------------------------------------- pages
@app.get("/")
def dashboard():
    return render_template("dashboard.html")


@app.get("/factory")
def factory_page():
    return render_template("factory.html")


# --------------------------------------------------------- API partagée
@app.get("/api/state")
def api_state():
    return jsonify(hub.full_state())


@app.get("/api/factory")
def api_factory():
    f = dict(hub.factory)
    f.pop("victims", None)      # positions cachées : le dashboard ne les connaît que quand le drone les trouve
    f.pop("demo", None)
    f["exits"] = hub.grid.exits
    return jsonify(f)


@app.post("/api/sensor")
def api_sensor():
    raw, d = request.get_data(), body()
    now = time.time()
    try:
        clean = clean_sensor(d, hub.factory)
    except (ValueError, TypeError) as e:
        hub.security_log(f"Message capteur refusé : {e}")
        return jsonify(ok=False, error=str(e), t=now), 400
    why = auth.check(clean["node"], request.headers, raw)
    if why:
        ts = request.headers.get("X-Hrika-Time", "0")
        if why == "message périmé" and ts.isdigit() and int(ts) < 1_000_000_000:
            print(f"[sécurité] {clean['node']} : horloge pas encore réglée, il se cale sur t")
        else:
            hub.security_log(f"Message capteur {clean['node']} rejeté : {why}")
        return jsonify(ok=False, error=why, t=now), 401
    hub.sensor(clean)
    return jsonify(ok=True, phase=hub.phase, t=now)


@app.post("/api/call_factory")
def api_call_factory():
    hub.call_factory()
    return jsonify(ok=True, phase=hub.phase)


@app.post("/api/factory/confirm")
def api_factory_confirm():
    d = body()
    origin = d.get("origin")
    try:
        if origin is not None:
            origin = [int(num(origin[0], 0, hub.grid.W - 1)), int(num(origin[1], 0, hub.grid.H - 1))]
    except (ValueError, TypeError, IndexError, KeyError):
        return bad("origine hors du plan")
    ok = hub.confirm(d.get("real") is True, origin)
    return jsonify(ok=ok, phase=hub.phase), (200 if ok else 409)


@app.post("/api/drone/launch")
def api_drone_launch():
    entry = body().get("entry", "E1")
    if entry not in {e["id"] for e in hub.grid.exits}:
        return bad("sortie inconnue")
    ok = hub.launch(entry)
    return jsonify(ok=ok, phase=hub.phase), (200 if ok else 409)


@app.post("/api/vision")
def api_vision():
    d = body()
    now = time.time()
    try:
        conf, jpg, person = num(d.get("conf", 0), 0, 1), clean_jpg(d.get("jpg")), d.get("person") is True
    except (ValueError, TypeError) as e:
        return bad(str(e) or "conf entre 0 et 1 attendue")
    with hub.lock:
        hub.health["vision"] = now
        if jpg:
            hub.camera = {"jpg": jpg, "at": now, "person": person, "conf": conf}
        if (hub.phase == "DRONE_INSIDE" and person and conf >= 0.5
                and now - hub.last_vision_add >= 10):
            hub.last_vision_add = now
            vid = hub.sim.add_victim_here(conf)
            hub.log(f"IA thermique : personne détectée (confiance {conf:.0%})"
                    + (f" → {vid}" if vid else ""), "victim")
    return jsonify(ok=True)


@app.get("/api/voice/next")
def api_voice_next():
    with hub.lock:
        hub.health["voix"] = time.time()
        return jsonify(hub.voice_queue.pop(0) if hub.voice_queue else {})


@app.post("/api/voice")
def api_voice():
    d = body()
    vid, status = d.get("victim"), d.get("status", "no_answer")
    heard = d.get("heard") if isinstance(d.get("heard"), str) else ""
    heard = heard[:300]
    if vid is not None and status not in security.VICTIM_STATUSES:
        return bad("statut inconnu")
    with hub.lock:
        hub.health["voix"] = time.time()
        if vid:
            try:
                hub.sim.set_victim_status(vid, status)
            except (KeyError, ValueError, TypeError):
                return bad("victime inconnue")
            hub.dialogs.setdefault(vid, []).append({"who": "victime", "text": heard or "(pas de réponse)",
                                                    "status": status, "t": time.strftime("%H:%M:%S")})
            fr = {"walking": "peut marcher", "injured": "BLESSÉ(E)", "no_answer": "NE RÉPOND PAS"}.get(status, status)
            hub.log(f"{vid} {fr} — « {heard or '…'} »", "victim")
    return jsonify(ok=True)


# ----------------------------------------------------- commandes dashboard
@app.post("/api/wind")
def api_wind():
    d = body()
    try:
        kmh, deg = num(d.get("kmh", 10), 0, 150), num(d.get("deg", 0), -360, 720) % 360
    except (ValueError, TypeError):
        return bad("vent invalide")
    with hub.lock:
        hub.sim.set_wind(kmh, deg)
        if hub.last:
            hub.last["wind"] = {"kmh": kmh, "deg": deg}
    return jsonify(ok=True)


@app.post("/api/victim/status")
def api_victim_status():
    """Le commandant corrige à la main l'état d'une victime."""
    d = body()
    if d.get("status") not in security.VICTIM_STATUSES:
        return bad("statut inconnu")
    with hub.lock:
        try:
            hub.sim.set_victim_status(d.get("victim"), d.get("status"))
        except (KeyError, ValueError, TypeError):
            return bad("victime inconnue")
        hub.log(f"Commandant : {d.get('victim')} marqué(e) « {d.get('status')} »", "decision")
    return jsonify(ok=True)


@app.post("/api/plan/decide")
def api_plan_decide():
    d = body()
    names = {"evacuation": "d'évacuation", "entry": "d'entrée", "extinguish": "d'extinction"}
    plan, dec = d.get("plan"), d.get("decision")
    if plan not in names or dec not in ("accepted", "rejected"):
        return bad("plan ou décision inconnus")
    with hub.lock:
        hub.decisions[plan] = {"decision": dec, "t": time.strftime("%H:%M:%S")}
        hub.log(f"Commandant : plan {names.get(plan, plan)} {'VALIDÉ' if dec == 'accepted' else 'REJETÉ'}",
                "decision")
    return jsonify(ok=True)


@app.post("/api/reset")
def api_reset():
    hub.reset()
    return jsonify(ok=True)


@app.post("/api/demo/<action>")
def api_demo(action):
    """Filet de sécurité pour la démo (panneau caché, touche D)."""
    d = body()
    with hub.lock:
        if action == "speed":
            try:
                hub.speed = max(0.5, min(8.0, num(d.get("value", 1), 0, 100)))
            except (ValueError, TypeError):
                return bad("vitesse invalide")
            hub.log(f"Vitesse de simulation ×{hub.speed:g}", "info")
        elif action == "alarm":
            hub.fake_alarm()
        elif action == "heat" and getattr(hub.sim, "drone", None):
            hub.heat_drone(12)
        elif action == "victim":
            vid = hub.sim.add_victim_here(0.9)
            hub.log(f"(démo) personne ajoutée à la position du drone → {vid}", "info")
        elif action == "skip":
            hub.skip()
    return jsonify(ok=True, phase=hub.phase)


if __name__ == "__main__":
    threading.Thread(target=hub.loop, daemon=True).start()
    port = int(os.environ.get("PORT", 5000))
    print(f"[hub] carte : {hub.path}  |  sim : {hub.sim_kind}  |  http://0.0.0.0:{port}")
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
