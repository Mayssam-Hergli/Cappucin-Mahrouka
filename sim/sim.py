"""The Sim class: the only public interface of the simulation.

Shared contract (do not change without telling the team):

    sim = Sim("sim/factory.json")
    sim.start_fire(x, y); sim.set_wind(kmh, deg); sim.launch_drone("E2")
    sim.step()                      # called every 0.5 s by the server
    sim.add_victim_here(conf)       # the webcam saw a person at the drone's position
    sim.set_victim_status("V1", "injured")
    sim.state()                     # JSON-ready dict

Helpers for the server and the dashboard (additions, they change nothing above):

    sim.map_info()                  # the map to draw, without the hidden victims
    sim.forecast(minutes=5)         # where the fire will be, for the EN_ROUTE phase
    sim.guidance("V1")              # exit, distance and the French sentence for the voice
    sim.set_drone_temp(temp)        # a real temperature reading for the drone (optional)
    sim.heat_drone(delta)           # demo button: the drone gets hotter (returns at 60 °C)

Every public method holds a lock, so the server can call step() from a
background thread while request handlers call the other methods.
"""

import copy
import os
import random
import threading

from . import plans
from .drone import OUT, RETURN_TEMP, Drone
from .grid import DOOR, Factory, WALL
from .hazards import GAS_THRESHOLD, SMOKE_THRESHOLD, Hazards

DT = 2.0                    # simulated seconds per step (demo-accelerated: 1 step every 0.5 s)
VICTIM_STATUSES = {"walking", "injured", "no_answer"}

PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(PACKAGE_DIR)
PUBLIC_MAP_KEYS = ("name", "cell_size_m", "legend", "grid", "zones", "exits",
                   "sensors", "hydrants", "gas_valves", "power_cutoffs", "equipment")


def _resolve(path):
    """Find the map whatever folder the server is started from."""
    if path is None:
        return os.path.join(PACKAGE_DIR, "factory.json")
    if os.path.isabs(path) or os.path.exists(path):
        return path
    from_root = os.path.join(REPO_ROOT, path)
    return from_root if os.path.exists(from_root) else path


class Sim:
    def __init__(self, path="sim/factory.json", seed=42, return_temp=RETURN_TEMP):
        self.factory = Factory(_resolve(path))
        self.rng = random.Random(seed)
        self.hazards = Hazards(self.factory, self.rng)
        self.return_temp = return_temp
        self.t = 0.0
        self.fire_started = False
        self.victims = [{"id": v["id"], "x": v["x"], "y": v["y"], "found": False, "status": "unknown"}
                        for v in self.factory.victims]
        self.drone = None
        self.plans = plans.empty()
        self.lookahead = True           # test each attack option ahead (False to save CPU)
        self._tested = {}               # latest result of plans.test_attacks()
        self._tested_key = None
        self._steps_since_test = 0
        self._lock = threading.RLock()

    # --- contract interface --------------------------------------------------

    def start_fire(self, x, y):
        """Start the fire at (x, y). A click on a wall moves to the nearest open cell."""
        with self._lock:
            x, y = self._nearest_open(int(x), int(y))
            self.hazards.ignite(x, y)
            self.fire_started = True
            self.plans = plans.compute(self.factory, self.hazards, self.victims)
            return [x, y]

    def set_wind(self, kmh, deg):
        with self._lock:
            self.hazards.set_wind(kmh, deg)

    def launch_drone(self, entry):
        with self._lock:
            if entry not in self.factory.exits:
                raise ValueError(f"unknown exit {entry!r}, expected one of {sorted(self.factory.exits)}")
            self.drone = Drone(self.factory, entry, self.return_temp)
            self.drone.scan(self.victims)

    def step(self):
        """Advance DT simulated seconds. Returns the ids of the victims found during this step."""
        with self._lock:
            found = []
            if self.fire_started:
                self.hazards.step()
            if self.drone is not None:
                found = self.drone.step(self.hazards, self.victims)
            if self.fire_started:
                self.plans = plans.compute(self.factory, self.hazards, self.victims, self._tested)
            self.t += DT
            job = self._lookahead_job()

        if job is not None:
            # Test the attack options on copies, outside the lock: state() stays responsive.
            tested = plans.test_attacks(self.factory, *job, DT)
            with self._lock:
                self._tested = tested
                self.plans = plans.compute(self.factory, self.hazards, self.victims, self._tested)
        return found

    def add_victim_here(self, conf):
        """The webcam saw a person at the drone's position.

        Returns the id of a NEWLY found victim (an existing hidden one nearby, or a new
        one created at the drone's position), so the server can queue the voice message.
        Returns None if the drone is not inside, or if the person is a victim already
        known: they were already spoken to, so no second message is queued.
        """
        with self._lock:
            if self.drone is None or self.drone.state == OUT:
                return None
            dx, dy = self.drone.x, self.drone.y
            near = [v for v in self.victims if max(abs(v["x"] - dx), abs(v["y"] - dy)) <= 3]
            for v in near:
                if not v["found"]:
                    v["found"] = True
                    return v["id"]
            if near:
                return None             # already known: no duplicate, no second voice message
            vid = f"V{len(self.victims) + 1}"
            self.victims.append({"id": vid, "x": dx, "y": dy, "found": True, "status": "unknown"})
            return vid

    def set_victim_status(self, victim_id, status):
        with self._lock:
            if status not in VICTIM_STATUSES:
                raise ValueError(f"unknown status {status!r}, expected one of {sorted(VICTIM_STATUSES)}")
            self._victim(victim_id)["status"] = status

    def state(self):
        with self._lock:
            hz = self.hazards
            drone = self.drone.as_dict() if self.drone is not None else None
            return {
                "t": self.t,
                "wind": {"kmh": hz.wind_kmh, "deg": hz.wind_deg},
                "fire": [[x, y] for (x, y) in hz.burning],
                "burnt": [[x, y] for (x, y) in hz.burnt],
                "smoke": hz.cells_above(hz.smoke, SMOKE_THRESHOLD),
                "gas": hz.cells_above(hz.gas, GAS_THRESHOLD),
                "drone": drone,
                "victims": [dict(v) for v in self.victims],
                "plans": copy.deepcopy(self.plans),
            }

    # --- helpers for the server and the dashboard -----------------------------

    def map_info(self):
        """The static map for the dashboard: grid rows, zones, exits, sensors, hydrants,
        gas valves and power cutoffs. The hidden victims are left out on purpose."""
        data = self.factory.data
        return copy.deepcopy({k: data[k] for k in PUBLIC_MAP_KEYS if k in data})

    def forecast(self, minutes=5):
        """Where the fire, smoke and gas will be in `minutes`, if nothing is done.

        Runs on a copy, so the live simulation is not changed. It takes a fraction
        of a second: call it once when the phase becomes EN_ROUTE (and again if the
        wind changes), not on every poll.
        """
        with self._lock:
            hz = copy.deepcopy(self.hazards, {id(self.factory): self.factory})
        for _ in range(int(minutes * 60 / DT)):
            hz.step(heat=False)
        return {
            "minutes": minutes,
            "fire": [[x, y] for (x, y) in hz.burning],
            "burnt": [[x, y] for (x, y) in hz.burnt],
            "smoke": hz.cells_above(hz.smoke, SMOKE_THRESHOLD),
            "gas": hz.cells_above(hz.gas, GAS_THRESHOLD),
        }

    def guidance(self, victim_id):
        """What the drone tells a victim: the safest exit, how far it is, and which
        doors to go through, plus the full French sentence for the voice script.

        Returns {"victim", "exit", "distance_m", "doors", "say"}.
        """
        with self._lock:
            v = self._victim(victim_id)
            line = next((p for p in self.plans["evacuation"] if p["victim"] == victim_id), None)
            if line is None:
                line = plans.evacuation_plan(self.factory, self.hazards, [v])[0]

            f = self.factory
            path = [tuple(c) for c in line["path"]]
            distance = sum(1.4142 if a[0] != b[0] and a[1] != b[1] else 1.0 for a, b in zip(path, path[1:]))
            doors = []
            for i, c in enumerate(path[1:-1], 1):
                if f.cell(*c) == DOOR:
                    zone = f.zone(f.zone_at(*path[i + 1]) or "")
                    doors.append((zone or {}).get("name_fr", "la pièce suivante"))

            hello = "Bonjour, je suis le drone de la Protection Civile. Restez calme."
            if line["exit"] is None:
                middle = "Restez où vous êtes, près du sol, couvrez votre bouche. La Protection Civile vient vous chercher."
            else:
                middle = f"La sortie la plus sûre est la sortie {line['exit']}, à {round(distance)} mètres"
                if doors:
                    middle += ", en passant par la porte vers " + ", puis la porte vers ".join(doors)
                middle += ". Restez près du sol. La Protection Civile est en route."
            return {
                "victim": victim_id,
                "exit": line["exit"],
                "distance_m": round(distance),
                "doors": doors,
                "say": f"{hello} {middle}",   # the drone only speaks, it does not ask anything
            }

    def heat_drone(self, delta):
        """Add `delta` °C to the drone (the dashboard's demo buttons). If that reaches
        the return temperature, the drone starts returning at once."""
        with self._lock:
            if self.drone is not None:
                self.drone.add_heat(delta)

    def set_drone_temp(self, temp):
        """Use a real temperature reading for the drone (for example an ESP32 + DHT22
        "drone box"), instead of the simulated one. None goes back to the simulation."""
        with self._lock:
            if self.drone is not None:
                self.drone.external_temp = None if temp is None else float(temp)

    # --- internals -----------------------------------------------------------

    def _lookahead_job(self):
        """A private snapshot for test_attacks(), when a new test is due; otherwise None.
        A test is due every LOOKAHEAD_EVERY steps, or at once if the burning zones,
        the victims found, their answers or the wind change."""
        if not (self.lookahead and self.fire_started and self.hazards.burning):
            return None
        hz = self.hazards
        key = (frozenset(filter(None, (self.factory.zone_at(*c) for c in hz.burning))),
               tuple((v["id"], v["status"]) for v in self.victims if v["found"]),
               hz.wind_kmh, hz.wind_deg)
        self._steps_since_test += 1
        if key == self._tested_key and self._steps_since_test < plans.LOOKAHEAD_EVERY:
            return None
        self._tested_key = key
        self._steps_since_test = 0
        return (copy.deepcopy(hz, {id(self.factory): self.factory}),
                copy.deepcopy(self.victims),
                copy.deepcopy(self.plans["evacuation"]))

    def _victim(self, victim_id):
        for v in self.victims:
            if v["id"] == victim_id:
                return v
        raise KeyError(f"unknown victim {victim_id!r}")

    def _nearest_open(self, x, y):
        f = self.factory
        x = min(max(x, 0), f.w - 1)
        y = min(max(y, 0), f.h - 1)
        if f.cell(x, y) != WALL:
            return x, y
        return min(f.open_cells, key=lambda c: (c[0] - x) ** 2 + (c[1] - y) ** 2)
