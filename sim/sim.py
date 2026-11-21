"""The Sim class: the only public interface of the simulation.

    sim = Sim("sim/factory.json")
    sim.start_fire(x, y); sim.set_wind(kmh, deg); sim.launch_drone("E2")
    sim.step()                      # called every 0.5 s by the server
    sim.add_victim_here(conf)       # the webcam saw a person at the drone's position
    sim.set_victim_status("V1", "injured")
    sim.state()                     # JSON-ready dict

Every public method holds a lock, so the server can call step() from a
background thread while request handlers call the other methods.
"""

import random
import threading

from .grid import Factory, WALL
from .hazards import GAS_THRESHOLD, SMOKE_THRESHOLD, Hazards

DT = 2.0                    # simulated seconds per step (demo-accelerated: 1 step every 0.5 s)
AMBIENT_TEMP = 25.0
VICTIM_STATUSES = {"walking", "injured", "no_answer"}


class Sim:
    def __init__(self, path="sim/factory.json", seed=42):
        self.factory = Factory(path)
        self.rng = random.Random(seed)
        self.hazards = Hazards(self.factory, self.rng)
        self.t = 0.0
        self.fire_started = False
        self.victims = [{"id": v["id"], "x": v["x"], "y": v["y"], "found": False, "status": "unknown"}
                        for v in self.factory.victims]
        self.drone = None
        self._lock = threading.RLock()

    # --- contract interface --------------------------------------------------

    def start_fire(self, x, y):
        """Start the fire at (x, y). A click on a wall moves to the nearest open cell."""
        with self._lock:
            x, y = self._nearest_open(int(x), int(y))
            self.hazards.ignite(x, y)
            self.fire_started = True
            return [x, y]

    def set_wind(self, kmh, deg):
        with self._lock:
            self.hazards.set_wind(kmh, deg)

    def launch_drone(self, entry):
        with self._lock:
            if entry not in self.factory.exits:
                raise ValueError(f"unknown exit {entry!r}, expected one of {sorted(self.factory.exits)}")
            x, y = self.factory.exits[entry]
            # Placeholder until drone.py: the drone waits at its entry door.
            self.drone = {"x": x, "y": y, "temp": AMBIENT_TEMP, "state": "EXPLORING", "entry": entry}

    def step(self):
        with self._lock:
            if self.fire_started:
                self.hazards.step()
            self.t += DT

    def add_victim_here(self, conf):
        """The webcam saw a person at the drone's position. Returns the victim id, or None."""
        with self._lock:
            if self.drone is None or self.drone["state"] == "OUT":
                return None
            dx, dy = self.drone["x"], self.drone["y"]
            near = [v for v in self.victims if max(abs(v["x"] - dx), abs(v["y"] - dy)) <= 3]
            for v in near:
                if not v["found"]:
                    v["found"] = True
                    return v["id"]
            if near:
                return near[0]["id"]    # already known: do not create a duplicate
            vid = f"V{len(self.victims) + 1}"
            self.victims.append({"id": vid, "x": dx, "y": dy, "found": True, "status": "unknown"})
            return vid

    def set_victim_status(self, victim_id, status):
        with self._lock:
            if status not in VICTIM_STATUSES:
                raise ValueError(f"unknown status {status!r}, expected one of {sorted(VICTIM_STATUSES)}")
            for v in self.victims:
                if v["id"] == victim_id:
                    v["status"] = status
                    return
            raise KeyError(f"unknown victim {victim_id!r}")

    def state(self):
        with self._lock:
            hz = self.hazards
            drone = None
            if self.drone is not None:
                drone = {k: self.drone[k] for k in ("x", "y", "temp", "state")}
            return {
                "t": self.t,
                "wind": {"kmh": hz.wind_kmh, "deg": hz.wind_deg},
                "fire": [[x, y] for (x, y) in hz.burning],
                "burnt": [[x, y] for (x, y) in hz.burnt],
                "smoke": hz.cells_above(hz.smoke, SMOKE_THRESHOLD),
                "gas": hz.cells_above(hz.gas, GAS_THRESHOLD),
                "drone": drone,
                "victims": [dict(v) for v in self.victims],
                "plans": {"evacuation": [], "entry": {"door": None, "path": []}, "extinguish": []},
            }

    # --- helpers -------------------------------------------------------------

    def _nearest_open(self, x, y):
        f = self.factory
        x = min(max(x, 0), f.w - 1)
        y = min(max(y, 0), f.h - 1)
        if f.cell(x, y) != WALL:
            return x, y
        return min(f.open_cells, key=lambda c: (c[0] - x) ** 2 + (c[1] - y) ** 2)
