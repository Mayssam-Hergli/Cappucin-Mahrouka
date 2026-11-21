"""Fire, smoke, gas and heat on the factory grid.

- Fire is a cellular automaton. A burning cell can ignite its neighbours, with a
  probability that depends on the material and the wind. Walls block it, doors
  slow it, and stored goods can also ignite across an aisle by radiant heat.
  Cells burn out after a time that depends on the material.
- Smoke and gas are density fields (0..1) that diffuse through open cells and
  vent out of the exits. Smoke is produced by every burning cell and spreads
  faster than fire. Gas leaks from gas bottles that are burning or next to a fire.
- Heat is the radiant heat felt in each cell, from burning cells up to
  HEAT_RADIUS cells away (walls block it). The drone and A* use it.
"""

import math

from .grid import DOOR, FLOOR, FUEL, GAS, PAPER, ELEC, EXIT, N4, N8, STOCK, WALL

# material: (ignition probability per step from one burning neighbour, burn time in steps)
MATERIALS = {
    FLOOR: (0.015, 6),      # bare concrete: only debris burns, briefly
    DOOR:  (0.03, 40),      # fire door: slows the fire
    PAPER: (0.30, 450),
    FUEL:  (0.55, 300),
    GAS:   (0.50, 120),
    ELEC:  (0.20, 200),
}

DIAGONAL_FACTOR = 0.7       # diagonal neighbours are further away
RADIANT_FACTOR = 0.2        # stored goods two cells away (across an aisle)
WIND_EFFECT = 1.5           # how much the wind pushes the fire
WIND_REF_KMH = 30.0         # wind speed for the full effect
GAS_IGNITION_BOOST = 0.3    # flammable gas makes a cell easier to ignite

SMOKE_SOURCE, SMOKE_DIFFUSION, SMOKE_SUBSTEPS, SMOKE_DECAY = 0.6, 0.6, 2, 0.995
GAS_SOURCE, GAS_DIFFUSION, GAS_SUBSTEPS, GAS_DECAY = 0.5, 0.35, 1, 0.995
EXIT_VENT = 0.3             # fraction of smoke or gas left on an exit cell after each step

SMOKE_THRESHOLD = 0.25      # density above which a cell is reported as smoky
GAS_THRESHOLD = 0.15        # density above which a cell is reported as gassy

HEAT_RADIUS = 3

# (dx, dy, factor, radiant, distance): the 8 neighbours, then the ring 2 cells away (radiant heat)
FIRE_OFFSETS = tuple(
    [(dx, dy, DIAGONAL_FACTOR if dx and dy else 1.0, False, math.hypot(dx, dy)) for dx, dy in N8]
    + [(dx, dy, RADIANT_FACTOR, True, math.hypot(dx, dy))
       for dx in range(-2, 3) for dy in range(-2, 3) if max(abs(dx), abs(dy)) == 2]
)


class Hazards:
    def __init__(self, factory, rng):
        self.f = factory
        self.rng = rng
        self.burning = {}           # (x, y) -> steps left
        self.burnt = set()
        self.smoke = [[0.0] * factory.w for _ in range(factory.h)]
        self.gas = [[0.0] * factory.w for _ in range(factory.h)]
        self.heat = {}              # (x, y) -> radiant heat
        self.wind_kmh = 0.0
        self.wind_deg = 0.0
        self._nb4 = {(x, y): [(x + dx, y + dy) for dx, dy in N4 if not factory.is_wall(x + dx, y + dy)]
                     for (x, y) in factory.open_cells}
        self._exits = [(x, y) for (x, y) in factory.open_cells if factory.cell(x, y) == EXIT]

    # --- controls ------------------------------------------------------------

    def ignite(self, x, y):
        if self.f.cell(x, y) not in MATERIALS or (x, y) in self.burning or (x, y) in self.burnt:
            return False
        self.burning[(x, y)] = MATERIALS[self.f.cell(x, y)][1]
        self._compute_heat()
        return True

    def set_wind(self, kmh, deg):
        self.wind_kmh = max(0.0, float(kmh))
        self.wind_deg = float(deg) % 360

    def wind_vector(self):
        """Unit vector of where the wind blows toward, in grid coordinates (y points down)."""
        rad = math.radians(self.wind_deg)
        return math.sin(rad), -math.cos(rad)

    # --- simulation ----------------------------------------------------------

    def step(self, smoke=True, heat=True):
        """One step. Look-ahead runs that only need the fire skip smoke and heat to go faster."""
        self._spread_fire()
        if smoke:
            self._diffuse(self.smoke, self.burning.keys(), SMOKE_SOURCE, SMOKE_DIFFUSION, SMOKE_SUBSTEPS, SMOKE_DECAY)
        self._diffuse(self.gas, self._gas_sources(), GAS_SOURCE, GAS_DIFFUSION, GAS_SUBSTEPS, GAS_DECAY)
        if heat:
            self._compute_heat()

    def extinguish(self, x, y):
        """Knock down a burning cell (it cannot catch fire again)."""
        if self.burning.pop((x, y), None) is not None:
            self.burnt.add((x, y))

    def _spread_fire(self):
        f = self.f
        wx, wy = self.wind_vector()
        strength = min(self.wind_kmh / WIND_REF_KMH, 1.0)
        not_ignited = {}    # cell -> probability that no burning cell ignites it this step

        for (x, y) in self.burning:
            for dx, dy, factor, radiant, dist in FIRE_OFFSETS:
                nx, ny = x + dx, y + dy
                if not f.inside(nx, ny) or (nx, ny) in self.burning or (nx, ny) in self.burnt:
                    continue
                target = f.cell(nx, ny)
                if target not in MATERIALS:
                    continue
                if radiant:
                    # only stored goods catch by radiant heat, and not through a wall
                    if target not in STOCK or f.is_wall(x + _sign(dx), y + _sign(dy)):
                        continue
                elif dx and dy and f.is_wall(x + dx, y) and f.is_wall(x, y + dy):
                    continue
                p = MATERIALS[target][0] + GAS_IGNITION_BOOST * self.gas[ny][nx]
                cos = (dx * wx + dy * wy) / dist
                p *= max(0.2, 1 + WIND_EFFECT * strength * cos) * factor
                p = min(p, 0.95)
                not_ignited[(nx, ny)] = not_ignited.get((nx, ny), 1.0) * (1 - p)

        new = [c for c, q in not_ignited.items() if self.rng.random() < 1 - q]

        for c in list(self.burning):
            self.burning[c] -= 1
            if self.burning[c] <= 0:
                del self.burning[c]
                self.burnt.add(c)
        for (x, y) in new:
            self.burning[(x, y)] = MATERIALS[f.cell(x, y)][1]

    def _gas_sources(self):
        sources = []
        for (x, y) in self.f.open_cells:
            if self.f.cell(x, y) != GAS or (x, y) in self.burnt:
                continue
            if (x, y) in self.burning or any((x + dx, y + dy) in self.burning for dx, dy in N8):
                sources.append((x, y))
        return sources

    def _diffuse(self, field, sources, amount, rate, substeps, decay):
        sources = list(sources)
        if not sources and not any(v > 1e-4 for row in field for v in row):
            return      # nothing to spread
        for (x, y) in sources:
            field[y][x] = min(1.0, field[y][x] + amount)
        for _ in range(substeps):
            new = [row[:] for row in field]
            for (x, y), nbs in self._nb4.items():
                if nbs:
                    mean = sum(field[ny][nx] for nx, ny in nbs) / len(nbs)
                    new[y][x] = field[y][x] + rate * (mean - field[y][x])
            field[:] = new
        for (x, y) in self.f.open_cells:
            field[y][x] *= decay
        for (x, y) in self._exits:
            field[y][x] *= EXIT_VENT

    def _compute_heat(self):
        heat = {}
        for start in self.burning:
            seen = {start}
            frontier = [start]
            for d in range(HEAT_RADIUS + 1):
                for c in frontier:
                    heat[c] = heat.get(c, 0.0) + 1.0 / (1 + d)
                nxt = []
                for (x, y) in frontier:
                    for nb in self._nb4.get((x, y), ()):
                        if nb not in seen:
                            seen.add(nb)
                            nxt.append(nb)
                frontier = nxt
        self.heat = heat

    # --- readings ------------------------------------------------------------

    def smoke_at(self, x, y):
        return self.smoke[y][x]

    def gas_at(self, x, y):
        return self.gas[y][x]

    def heat_at(self, x, y):
        return self.heat.get((x, y), 0.0)

    def cells_above(self, field, threshold):
        return [[x, y] for (x, y) in self.f.open_cells if field[y][x] >= threshold]


def _sign(v):
    return (v > 0) - (v < 0)
