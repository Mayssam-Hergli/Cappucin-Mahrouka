"""FakeSim : remplaçant de la Sim de Teammate 2, avec EXACTEMENT la même interface.

    sim = FakeSim("sim/factory.json")
    sim.start_fire(x, y); sim.set_wind(kmh, deg); sim.launch_drone("E2")
    sim.step()                      # appelé toutes les 0,5 s
    sim.add_victim_here(conf)
    sim.set_victim_status("V1", "walking|injured|no_answer")
    sim.state()

Elle sert à développer et tester le dashboard sans attendre la vraie Sim.
Quand sim/ est prête, le serveur l'importe automatiquement (voir app.py).

Vent : même convention que la vraie Sim (contrat du README) : deg = direction VERS laquelle
souffle le vent, 0 = nord, 90 = est, 180 = sud, 270 = ouest.
"""
import json
import math
import random

from geo import Grid, N4

# probabilité d'allumer un voisin par pas (0,5 s) et durée de combustion (pas)
IGNITE = {"F": 0.20, "G": 0.25, "P": 0.12, "X": 0.08, ".": 0.016, "D": 0.025, "E": 0.005}
# les marchandises brûlent jusqu'à l'extinction (comme la vraie Sim) ; sol et portes s'éteignent seuls
BURN = {"F": 10**9, "G": 10**9, "P": 10**9, "X": 10**9, ".": 320, "D": 260, "E": 60}
FIRE_CLASS = {"P": "A", "F": "B", "G": "C", "X": "E", ".": "A", "D": "A", "E": "A"}
AGENT = {"A": "eau", "B": "mousse", "C": "poudre", "E": "CO2"}


class FakeSim:
    def __init__(self, path, seed=7):
        with open(path, encoding="utf-8") as f:
            self.factory = json.load(f)
        self.g = Grid(self.factory)
        self.rng = random.Random(seed)
        self.t = 0.0
        self.wind = {"kmh": 10, "deg": 0}
        self.fire = {}          # (x,y) -> pas restants
        self.burnt = set()
        self.smoke = {}         # (x,y) -> densité 0..1
        self.gas = {}           # (x,y) -> densité 0..1
        self.victims = [dict(v, found=False, status=None) for v in self.factory.get("victims", [])]
        self.drone = None
        self.explored = set()
        self.plans = {"evacuation": [], "entry": None, "extinguish": []}
        self._n = 0

    # ----------------------------------------------------------------- API
    def start_fire(self, x, y):
        x, y = int(x), int(y)
        if not self.g.walkable(x, y):        # clic sur un mur : on prend un voisin
            for n in self.g.neighbors(x, y):
                x, y = n
                break
        self.fire[(x, y)] = BURN.get(self.g.cell(x, y), 20)

    def set_wind(self, kmh, deg):
        self.wind = {"kmh": float(kmh), "deg": float(deg)}

    def launch_drone(self, entry="E1"):
        e = self.g.exit_by_id(entry)
        self.drone = {"x": e["x"], "y": e["y"], "temp": 24.0, "state": "EXPLORING",
                      "entry": e["id"], "path": []}
        self._reveal()

    def add_victim_here(self, conf=1.0):
        if not self.drone:
            return None
        x, y = self.drone["x"], self.drone["y"]
        for v in self.victims:              # déjà une victime à côté : on la confirme
            if abs(v["x"] - x) + abs(v["y"] - y) <= 2:
                v["found"] = True
                return v["id"]
        vid = f"V{len(self.victims) + 1}"
        self.victims.append({"id": vid, "x": x, "y": y, "found": True, "status": None,
                             "conf": conf})
        return vid

    def set_victim_status(self, vid, status):
        for v in self.victims:
            if v["id"] == vid:
                v["status"] = status

    # ---------------------------------------------------------------- step
    def step(self):
        self.t = round(self.t + 0.5, 1)
        self._n += 1
        self._spread_fire()
        self._spread(self.smoke, sources=self.fire.keys(), p=0.45, decay=0.985, loss=0.91)
        gas_src = [c for c in self.fire if self.g.cell(*c) == "G"]
        self._spread(self.gas, sources=gas_src, p=0.30, decay=0.99, loss=0.9)
        if self.drone and self.drone["state"] != "OUT":
            self._drone_step()
        if self.drone and self._n % 4 == 0:
            self._compute_plans()

    def _spread_fire(self):
        wr = math.radians(self.wind["deg"])
        wx, wy = math.sin(wr), -math.cos(wr)      # 0 = nord, 90 = est (y vers le bas)
        wk = self.wind["kmh"] / 20.0
        new = {}
        for (x, y), left in list(self.fire.items()):
            for dx, dy in N4:
                n = (x + dx, y + dy)
                if n in self.fire or n in new or n in self.burnt:
                    continue
                c = self.g.cell(*n)
                if c == "#":
                    continue
                p = IGNITE.get(c, 0.02) * max(0.25, 1 + wk * (dx * wx + dy * wy))
                if self.rng.random() < p:
                    new[n] = BURN.get(c, 20)
            if left <= 1:
                del self.fire[(x, y)]
                self.burnt.add((x, y))
            else:
                self.fire[(x, y)] = left - 1
        self.fire.update(new)

    def _spread(self, field, sources, p, decay, loss):
        for s in sources:
            field[s] = 1.0
        for (x, y), d in list(field.items()):
            for n in self.g.neighbors(x, y):
                nd = d * (loss * 0.75 if self.g.cell(*n) == "D" else loss)
                if nd > field.get(n, 0) and self.rng.random() < p:
                    field[n] = nd
            field[(x, y)] = d * decay
        for k in [k for k, d in field.items() if d < 0.15]:
            del field[k]

    # --------------------------------------------------------------- drone
    def _reveal(self):
        d = self.drone
        for c in self.g.visible_cells(d["x"], d["y"], 3):
            self.explored.add(c)
        for v in self.victims:
            if not v["found"] and (v["x"], v["y"]) in self.explored:
                if (v["x"] - d["x"]) ** 2 + (v["y"] - d["y"]) ** 2 <= 9:
                    v["found"] = True

    def heat_at(self, x, y):
        h = 0.0
        for (fx, fy) in self.fire:
            dd = (fx - x) ** 2 + (fy - y) ** 2
            if dd <= 36:
                h += 1.0 / (1 + dd)
        return h

    def _cost(self, c):
        return 6 * self.heat_at(*c) + 3 * self.smoke.get(c, 0) + 5 * self.gas.get(c, 0)

    def _drone_step(self):
        d = self.drone
        # température : monte près du feu, redescend ailleurs
        target = 24 + 48 * self.heat_at(d["x"], d["y"]) + 8 * self.smoke.get((d["x"], d["y"]), 0)
        d["temp"] = round(d["temp"] + (target - d["temp"]) * 0.08 + 0.12, 1)

        if d["state"] == "EXPLORING" and d["temp"] >= 60:
            d["state"] = "RETURNING"
            d["path"] = []
        if d["state"] == "EXPLORING":
            if not d["path"]:
                d["path"] = self._path_to_frontier()
                if not d["path"]:
                    d["state"] = "RETURNING"
        if d["state"] == "RETURNING" and not d["path"]:
            d["path"] = self._path_to_exit()
            if not d["path"]:
                d["state"] = "OUT"
                return
        if d["path"]:
            nx, ny = d["path"].pop(0)
            if (nx, ny) in self.fire:          # le feu a bloqué la route : on recalcule
                d["path"] = []
                return
            d["x"], d["y"] = nx, ny
            self._reveal()
            if d["state"] == "RETURNING" and self.g.cell(nx, ny) == "E" and not d["path"]:
                d["state"] = "OUT"
        # ne pas suivre un vieux chemin trop longtemps : on replanifie souvent
        if d["state"] == "EXPLORING" and len(d["path"]) > 6:
            d["path"] = d["path"][:6]

    def _path_to_frontier(self):
        from collections import deque
        start = (self.drone["x"], self.drone["y"])
        prev = {start: None}
        q = deque([start])
        while q:
            cur = q.popleft()
            if cur not in self.explored and cur != start:
                path = []
                while cur != start:
                    path.append(list(cur))
                    cur = prev[cur]
                return path[::-1]
            for n in self.g.neighbors(*cur):
                if n in prev or n in self.fire:
                    continue
                if self.g.cell(*n) == "E":
                    continue                     # ne pas ressortir en explorant
                prev[n] = cur
                q.append(n)
        return []

    def _path_to_exit(self):
        start = (self.drone["x"], self.drone["y"])
        best = None
        for e in self.g.exits:
            p = self.g.astar(start, (e["x"], e["y"]), self._cost, frozenset(self.fire))
            if p and (best is None or len(p) < len(best)):
                best = p
        return [c for c in best[1:]] if best else []

    # --------------------------------------------------------------- plans
    def _path_cost(self, p):
        return sum(1 + self._cost(tuple(c)) for c in p)

    def _compute_plans(self):
        blocked = frozenset(self.fire)
        found = [v for v in self.victims if v["found"]]
        evac = []
        for v in found:
            best, bexit = None, None
            for e in self.g.exits:
                p = self.g.astar((v["x"], v["y"]), (e["x"], e["y"]), self._cost, blocked)
                if p and (best is None or self._path_cost(p) < self._path_cost(best)):
                    best, bexit = p, e["id"]
            evac.append({"victim": v["id"], "path": best or [], "exit": bexit,
                         "rescue_first": v["status"] in ("injured", "no_answer")})

        entry = None
        if found:
            best_total = math.inf
            for e in self.g.exits:
                total, first = 0, None
                for v in sorted(found, key=lambda v: v["status"] not in ("injured", "no_answer")):
                    p = self.g.astar((e["x"], e["y"]), (v["x"], v["y"]), self._cost, blocked)
                    if not p:
                        total = math.inf
                        break
                    total += self._path_cost(p)
                    first = first or p
                if total < best_total:
                    best_total, entry = total, {"door": e["id"], "path": first}

        # extinction : une ligne par zone en feu
        wr = math.radians(self.wind["deg"])
        upwind = _side_fr(-math.sin(wr), math.cos(wr))
        victim_zones = {self.g.zone_of(c[0], c[1]) for ev in evac for c in ev["path"]}
        ext = []
        for z in self.g.zones:
            cells = [c for c in self.fire if self.g.zone_of(*c) == z["id"]]
            if not cells:
                continue
            mats = {self.g.cell(*c) for c in cells}
            cls = "C" if "G" in mats else "E" if "X" in mats else "B" if "F" in mats else "A"
            agent = AGENT[cls]
            if cls == "C":
                agent = "fermer la vanne gaz, puis poudre"
            elif cls == "E":
                agent = "couper le courant, puis CO2"
            prio = 0 if z["id"] in victim_zones else 1 if cls in ("B", "C") else 2
            ext.append({"zone": z["id"], "fire_class": cls, "agent": agent,
                        "attack_from": upwind, "prio": prio, "cells": len(cells)})
        ext.sort(key=lambda e: (e["prio"], -e["cells"]))
        for i, e in enumerate(ext):
            e["order"] = i + 1
            del e["prio"], e["cells"]
        self.plans = {"evacuation": evac, "entry": entry, "extinguish": ext}

    # --------------------------------------------------------------- state
    def state(self):
        d = self.drone
        return {
            "t": self.t,
            "wind": dict(self.wind),
            "fire": [list(c) for c in self.fire],
            "smoke": [list(c) for c in self.smoke],
            "gas": [list(c) for c in self.gas],
            "drone": ({"x": d["x"], "y": d["y"], "temp": d["temp"], "state": d["state"]}
                      if d else None),
            "victims": [{"id": v["id"], "x": v["x"], "y": v["y"], "found": v["found"],
                         "status": v["status"]} for v in self.victims],
            "plans": self.plans,
        }


def _side_fr(dx, dy):
    if abs(dx) >= abs(dy):
        return "côté est" if dx > 0 else "côté ouest"
    return "côté sud" if dy > 0 else "côté nord"
