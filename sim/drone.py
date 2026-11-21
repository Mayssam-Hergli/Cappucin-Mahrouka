"""The virtual scout drone.

- Enters by the chosen exit door, then explores: it always flies toward the
  cheapest-to-reach cell it has not seen yet (it avoids heat, and never flies
  through flames). It moves SPEED cells per step (1 m/s).
- Its thermal camera sees THERMAL_RANGE cells around it (walls block the view).
  Every hidden victim in view is marked as found.
- When it finds a victim it hovers for a moment to talk to them, until the
  victim answers or HOVER_MAX_STEPS have passed.
- Its temperature moves toward a target set by the radiant heat and the hot
  smoke around it (or comes from a real sensor, if one sends readings).
  At return_temp (60 °C by default) it switches to RETURNING and takes the safest
  path to the nearest exit. It also returns once nothing is left to explore.
  At the exit it is OUT.
"""

from .grid import N4
from .pathfinding import safest_to_any

RETURN_TEMP = 60.0
THERMAL_RANGE = 3
SPEED = 2               # cells per step: 1 m/s with 2 simulated seconds per step
AMBIENT_TEMP = 25.0
HEAT_GAIN = 40.0        # °C added to the target temperature per unit of radiant heat
SMOKE_GAIN = 15.0       # °C added by dense hot smoke
TEMP_RESPONSE = 0.15    # how fast the drone's temperature follows the target, per step
HOVER_MAX_STEPS = 16    # 8 s of real time at one step every 0.5 s

EXPLORING, RETURNING, OUT = "EXPLORING", "RETURNING", "OUT"


class Drone:
    def __init__(self, factory, entry, return_temp=RETURN_TEMP):
        self.f = factory
        self.entry = entry
        self.return_temp = return_temp
        self.external_temp = None       # a real temperature reading, if a sensor sends one
        self.x, self.y = factory.exits[entry]
        self.temp = AMBIENT_TEMP
        self.state = EXPLORING
        self.return_reason = None       # "heat" or "explored"
        self.seen = set()
        self._exits = set(factory.exits.values())
        self.talking_to = None
        self._hover = 0

    def as_dict(self):
        return {"x": self.x, "y": self.y, "temp": round(self.temp, 1), "state": self.state}

    def step(self, hz, victims):
        """Move one step. Returns the ids of the victims found during this step."""
        if self.state == OUT:
            return []

        if self.external_temp is not None:
            self.temp = self.external_temp
        else:
            target = AMBIENT_TEMP + HEAT_GAIN * hz.heat_at(self.x, self.y) + SMOKE_GAIN * hz.smoke[self.y][self.x]
            self.temp += TEMP_RESPONSE * (target - self.temp)
        if self.state == EXPLORING and self.temp >= self.return_temp:
            self._start_return("heat")

        found = []
        for _ in range(SPEED):
            new = self.scan(victims)
            found += new
            if self.state == EXPLORING:
                if new:
                    self.talking_to, self._hover = new[0], 0
                if self._still_talking(victims):
                    break
                path = self._path_to_unexplored(hz)
                if path is None:
                    self._start_return("explored")
                else:
                    self._move_along(path)
            if self.state == RETURNING:
                if not self._at_exit():
                    _, path, _ = safest_to_any(self.f, hz, (self.x, self.y), lambda x, y: (x, y) in self._exits)
                    if path:
                        self._move_along(path)
                if self._at_exit():
                    self.state = OUT
                    break
        found += self.scan(victims)
        return found

    def add_heat(self, delta):
        """A sudden rise in temperature (demo button). Returns at once if it reaches return_temp."""
        if self.state == OUT:
            return
        self.temp += float(delta)
        if self.state == EXPLORING and self.temp >= self.return_temp:
            self._start_return("heat")

    def scan(self, victims):
        """Mark every cell within thermal range as seen; return the ids of newly found victims."""
        seen_now = {(self.x, self.y)}
        frontier = [(self.x, self.y)]
        for _ in range(THERMAL_RANGE):
            nxt = []
            for (x, y) in frontier:
                for dx, dy in N4:
                    c = (x + dx, y + dy)
                    if c not in seen_now and not self.f.is_wall(*c):
                        seen_now.add(c)
                        nxt.append(c)
            frontier = nxt
        self.seen |= seen_now

        found = []
        for v in victims:
            if not v["found"] and (v["x"], v["y"]) in seen_now:
                v["found"] = True
                found.append(v["id"])
        return found

    # --- helpers -------------------------------------------------------------

    def _still_talking(self, victims):
        if self.talking_to is None:
            return False
        answered = any(v["id"] == self.talking_to and v["status"] != "unknown" for v in victims)
        self._hover += 1
        if answered or self._hover > HOVER_MAX_STEPS:
            self.talking_to = None
            return False
        return True

    def _path_to_unexplored(self, hz):
        _, path, _ = safest_to_any(self.f, hz, (self.x, self.y),
                                   lambda x, y: (x, y) not in self.seen)
        return path

    def _at_exit(self):
        return (self.x, self.y) in self._exits

    def _move_along(self, path):
        if len(path) > 1:
            self.x, self.y = path[1]

    def _start_return(self, reason):
        self.state = RETURNING
        self.return_reason = reason
        self.talking_to = None
