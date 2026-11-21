"""Analyse « live » pour le dashboard (n'utilise que sim.state(), pas l'intérieur de la Sim).

À chaque pas :
  * la carte se découvre autour du drone (caméra thermique, rayon 3 m, murs opaques) ;
  * le drone « mesure » ce qu'il voit / respire : température, CO, gaz, fumée, O₂ ;
  * les capteurs fixes donnent leurs valeurs (ESP32 réel si connecté, sinon simulées) ;
  * chaque zone garde ses dernières mesures (avec leur âge), un historique court,
    un niveau NORMAL / WARNING / DANGER (avec hystérésis) et des phrases de risque ;
  * seules les mesures importantes (score >= 0,5) sont gardées, triées, top 3.
"""
import math
from collections import deque

from geo import Grid

THRESH = {"temp": 60.0, "co": 50.0, "gas": 10.0, "smoke": 30.0, "mq": 1500.0}
UNIT = {"temp": "°C", "co": "ppm", "gas": "% LIE", "smoke": "%", "o2": "%", "mq": ""}
LABEL = {"temp": "Température", "co": "CO", "gas": "Gaz inflammable", "smoke": "Fumée",
         "o2": "Oxygène", "mq": "Capteur gaz/fumée"}
ICON = {"temp": "🌡", "co": "☠", "gas": "🧪", "smoke": "💨", "o2": "🫁", "mq": "📡"}

UP = {"WARNING": 0.6, "DANGER": 1.0}      # seuils de montée
DOWN = {"WARNING": 0.45, "DANGER": 0.8}   # seuils de descente (hystérésis)
STALE = 45.0                               # au-delà, une mesure compte moins


BASE = {"temp": 20.0, "co": 0.0, "gas": 0.0, "smoke": 0.0, "mq": 300.0}   # valeurs "normales"


def score(kind, v):
    """0 = normal, 1 = au seuil de danger (on part de la valeur ambiante, pas de zéro)."""
    if kind == "o2":
        return max(0.0, (20.9 - v) / (20.9 - 19.5))
    return max(0.0, (v - BASE[kind]) / (THRESH[kind] - BASE[kind]))


def _noise(x, y, t, k=0.0):
    return 0.5 + 0.5 * math.sin(t * 1.3 + x * 12.9898 + y * 78.233 + k)


class Analyzer:
    def __init__(self, factory):
        self.factory = factory
        self.g = Grid(factory)
        self.equipment = factory.get("equipment", [])
        self.zone_name = {z["id"]: z["name"] for z in self.g.zones}
        self.zone_cells = {z["id"]: [] for z in self.g.zones}
        for y in range(self.g.H):
            for x in range(self.g.W):
                if self.g.walkable(x, y):
                    zid = self.g.zone_of(x, y)
                    if zid in self.zone_cells:
                        self.zone_cells[zid].append((x, y))
        self.reset()

    def reset(self):
        self.explored = set()
        self.trail = []
        self.alerts = []
        self.alert_seq = 0
        self.fire_started = False
        self.sensors = {}
        self.z = {zid: {"level": "NORMAL", "readings": {}, "hist": {}, "hist_t": {}, "risks": []}
                  for zid in self.zone_name}
        self._dist = {}
        self._smoke = set()
        self._gas = set()

    # ------------------------------------------------------- valeurs physiques
    def values_at(self, x, y, t):
        d = self._dist.get((x, y))
        n = _noise(x, y, t)
        if d == 0:
            temp = 380 + 220 * n
        elif d is not None:
            temp = 21 + 420 * math.exp(-d / 1.6) * (0.9 + 0.2 * n)
        else:
            temp = 21 + 1.5 * n
        smoky = (x, y) in self._smoke
        smoke = (55 + 40 * n) if smoky else 0.0
        far = 10 if d is None else d
        co = (60 + 900 * math.exp(-far / 4)) * (0.9 + 0.2 * n) if smoky else 2 + 2 * n
        gas = (12 + 45 * _noise(x, y, t, 2)) if (x, y) in self._gas else 0.0
        o2 = 20.9 - (3.2 * (0.8 + 0.4 * n) if smoky else 0) - (2.5 * math.exp(-far / 2))
        return {"temp": temp, "smoke": smoke, "co": co, "gas": gas, "o2": o2}

    # ------------------------------------------------------------------ update
    def update(self, st, now, real_sensors):
        """st = sim.state() (ou None avant l'incendie). Renvoie les nouveaux événements."""
        events = []
        if st:
            fire = [tuple(c) for c in st.get("fire", [])]
            if fire:
                self.fire_started = True
            self._dist = self.g.distance_field(fire, max_d=10) if fire else {}
            self._smoke = {tuple(c) for c in st.get("smoke", [])}
            self._gas = {tuple(c) for c in st.get("gas", [])}
            self._drone_measure(st, now)
        self._fixed_sensors(now, real_sensors)
        events += self._levels(now)
        self._risks(st, now)
        return events

    def _record(self, zid, kind, value, x, y, now, src):
        if zid not in self.z:
            return
        z = self.z[zid]
        z["readings"][kind + ":" + src] = {"type": kind, "value": round(value, 1), "x": x, "y": y,
                                           "t": now, "src": src}
        key = kind + ":" + src
        if now - z["hist_t"].get(key, 0) >= 1.0:
            z["hist"].setdefault(key, deque(maxlen=24)).append(round(value, 1))
            z["hist_t"][key] = now

    def _drone_measure(self, st, now):
        d = st.get("drone")
        if not d or d.get("state") == "OUT":
            return
        px, py = int(round(d["x"])), int(round(d["y"]))
        if not self.trail or self.trail[-1] != [px, py]:
            self.trail.append([px, py])
            self.trail = self.trail[-400:]
        vis = self.g.visible_cells(px, py, 3)
        self.explored.update(vis)
        t = st.get("t", now)

        # caméra thermique : point le plus chaud et part de fumée, par zone vue
        by_zone = {}
        for (x, y) in vis:
            if self.g.walkable(x, y):
                by_zone.setdefault(self.g.zone_of(x, y), []).append((x, y))
        for zid, cells in by_zone.items():
            vals = [(self.values_at(x, y, t), x, y) for x, y in cells]
            v, x, y = max(vals, key=lambda a: a[0]["temp"])
            self._record(zid, "temp", v["temp"], x, y, now, "drone")
            frac = 100.0 * sum(1 for c in cells if c in self._smoke) / len(cells)
            if frac > 0:
                sx, sy = next((c for c in cells if c in self._smoke), (x, y))
                self._record(zid, "smoke", frac, sx, sy, now, "drone")
            else:
                self._record(zid, "smoke", 0, x, y, now, "drone")

        # capteurs embarqués (air autour du drone, rayon 1)
        near = [(x, y) for x in range(px - 1, px + 2) for y in range(py - 1, py + 2)
                if self.g.walkable(x, y)]
        vals = [self.values_at(x, y, t) for x, y in near] or [self.values_at(px, py, t)]
        zid = self.g.zone_of(px, py)
        self._record(zid, "co", max(v["co"] for v in vals), px, py, now, "drone")
        self._record(zid, "gas", max(v["gas"] for v in vals), px, py, now, "drone")
        self._record(zid, "o2", min(v["o2"] for v in vals), px, py, now, "drone")

    def _fixed_sensors(self, now, real):
        for s in self.factory.get("sensors", []):
            sid, x, y, zid = s["id"], s["x"], s["y"], s["zone"]
            r = real.get(sid)
            if r and now - r["at"] < 5:
                temp, mq, level, src = r.get("temp", 0), r.get("gas", 0), r.get("level", "NORMAL"), "real"
            else:
                v = self.values_at(x, y, now) if self.fire_started else {
                    "temp": 22 + _noise(x, y, now), "smoke": 0, "co": 2}
                temp = v["temp"]
                mq = 300 + 4 * v["smoke"] * (1 + v["co"] / 400) + 40 * _noise(x, y, now, 4)
                level = "ALARM" if (temp > 57 or mq > 1500) else "WARNING" if (temp > 40 or mq > 900) else "NORMAL"
                src = "sim"
            self.sensors[sid] = {"id": sid, "zone": zid, "x": x, "y": y, "temp": round(temp, 1),
                                 "gas": round(mq), "level": level, "src": src}
            self._record(zid, "temp", temp, x, y, now, sid)
            self._record(zid, "mq", mq, x, y, now, sid)

    def _top(self, zid, now, n=3):
        z = self.z[zid]
        best = {}
        for key, r in z["readings"].items():
            s = score(r["type"], r["value"])
            age = now - r["t"]
            if age > STALE:
                s *= 0.7
            h = list(z["hist"].get(key, []))
            trend = "flat"
            if len(h) >= 6:
                a, b = h[-6], h[-1]
                if b > a * 1.05 + 0.5:
                    trend = "up"
                elif b < a * 0.95 - 0.5:
                    trend = "down"
            if r["type"] == "o2":
                trend = {"up": "down", "down": "up"}.get(trend, trend)   # danger quand O₂ baisse
            if trend == "up":
                s *= 1.3
            item = dict(r, score=round(s, 2), age=round(age, 1), trend=trend, hist=h,
                        unit=UNIT[r["type"]], label=LABEL[r["type"]], icon=ICON[r["type"]])
            item.pop("t")
            # une seule ligne par type (la plus grave)
            if r["type"] not in best or s > best[r["type"]]["score"]:
                best[r["type"]] = item
        items = sorted(best.values(), key=lambda i: i["score"], reverse=True)
        return [i for i in items if i["score"] >= 0.5][:n], items

    def _levels(self, now):
        events = []
        for zid, z in self.z.items():
            top, _ = self._top(zid, now)
            smax = top[0]["score"] if top else 0
            lvl = z["level"]
            new = lvl
            if smax >= UP["DANGER"]:
                new = "DANGER"
            elif lvl == "DANGER" and smax >= DOWN["DANGER"]:
                new = "DANGER"
            elif smax >= UP["WARNING"] or (lvl != "NORMAL" and smax >= DOWN["WARNING"]):
                new = "WARNING"
            else:
                new = "NORMAL"
            if new != lvl:
                z["level"] = new
                if new == "DANGER":
                    r = top[0]
                    txt = (f"DANGER {zid} {self.zone_name[zid]} : {r['label']} "
                           f"{round(r['value'])} {r['unit']}".strip())
                    self.alert_seq += 1
                    self.alerts.append({"id": self.alert_seq, "zone": zid, "at": now, "text": txt})
                    self.alerts = self.alerts[-10:]
                    events.append(("danger", txt))
                elif new == "WARNING" and lvl == "NORMAL":
                    r = top[0]
                    events.append(("warn", f"Vigilance {zid} {self.zone_name[zid]} : {r['label']} "
                                           f"{round(r['value'])} {r['unit']}".strip()))
        return events

    def _risks(self, st, now):
        victims = [v for v in (st or {}).get("victims", []) if v.get("found")]
        for zid, z in self.z.items():
            risks = []
            known = z["level"] != "NORMAL" or any(c in self.explored for c in self.zone_cells[zid])
            top = {r["type"]: r for r in self._top(zid, now)[1]}

            def near_fire(t_types, d_max=4):
                best = None
                for e in self.equipment:
                    if e["type"] in t_types and self.g.zone_of(e["x"], e["y"]) == zid:
                        d = self._dist.get((e["x"], e["y"]))
                        if d is not None and d <= d_max and (best is None or d < best[0]):
                            best = (d, e)
                return best

            if self.fire_started and (known or z["level"] != "NORMAL"):
                g = near_fire({"gas", "valve"})
                if g:
                    risks.append((3, f"🧪 {g[1]['label']} à {g[0]} m du feu : risque d'explosion, fermer la vanne gaz"))
                e = near_fire({"electric"})
                if e:
                    risks.append((2, f"⚡ {e[1]['label']} exposé au feu : couper le courant avant l'eau"))
                s = near_fire({"solvent"})
                if s:
                    risks.append((2, f"🛢 {s[1]['label']} à {s[0]} m : solvants, attaque à la mousse"))
                m = near_fire({"metal"}, 2)
                if m:
                    risks.append((1, f"⚙ {m[1]['label']} : métal chaud, risque de brûlure / effondrement"))
            co = top.get("co")
            if co and co["value"] >= 200:
                risks.append((3, f"☠ CO {round(co['value'])} ppm : mortel en quelques minutes"))
            o2 = top.get("o2")
            if o2 and o2["value"] < 19.5:
                risks.append((2, f"🫁 O₂ {o2['value']} % : appareil respiratoire (ARI) obligatoire"))
            t = top.get("temp")
            if t and t["value"] >= 60:
                risks.append((1, f"🌡 {round(t['value'])} °C : zone trop chaude pour le drone"))
            vz = [v["id"] for v in victims if self.g.zone_of(v["x"], v["y"]) == zid]
            if vz:
                risks.append((4, f"👤 Victime(s) {', '.join(vz)} dans la zone"))
            risks.sort(key=lambda r: -r[0])
            z["risks"] = [r[1] for r in risks[:4]]

    # ---------------------------------------------------------------- export
    def snapshot(self, now):
        zones = {}
        for zid, z in self.z.items():
            top, _ = self._top(zid, now)
            cells = self.zone_cells[zid]
            scanned = sum(1 for c in cells if c in self.explored) / max(1, len(cells))
            zones[zid] = {"name": self.zone_name[zid], "level": z["level"],
                          "scanned": round(scanned, 2), "top": top, "risks": z["risks"]}
        return {
            "explored": [list(c) for c in self.explored],
            "trail": self.trail[-200:],
            "zones": zones,
            "sensors": list(self.sensors.values()),
            "alerts": self.alerts,
        }
