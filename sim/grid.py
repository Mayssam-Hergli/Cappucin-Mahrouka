"""Factory map: loads factory.json and answers questions about its cells.

Coordinates: x = column, y = row, origin at the top-left, 1 cell = 1 m.
"""

import json

WALL, FLOOR, EXIT, DOOR = "#", ".", "E", "D"
PAPER, FUEL, GAS, ELEC = "P", "F", "G", "X"

CELL_TYPES = {WALL, FLOOR, EXIT, DOOR, PAPER, FUEL, GAS, ELEC}
WALKABLE = {FLOOR, DOOR, EXIT}          # where people and the drone can move
STOCK = {PAPER, FUEL, GAS, ELEC}        # stored goods and equipment: obstacles, but burnable

N4 = ((1, 0), (-1, 0), (0, 1), (0, -1))
N8 = N4 + ((1, 1), (1, -1), (-1, 1), (-1, -1))


class Factory:
    def __init__(self, path):
        with open(path, encoding="utf-8") as f:
            data = json.load(f)

        self.name = data.get("name", "factory")
        self.rows = data["grid"]
        self.h = len(self.rows)
        self.w = len(self.rows[0])
        for i, row in enumerate(self.rows):
            if len(row) != self.w:
                raise ValueError(f"grid row {i} has {len(row)} cells, expected {self.w}")
            unknown = set(row) - CELL_TYPES
            if unknown:
                raise ValueError(f"grid row {i} has unknown cell types {sorted(unknown)}")

        self.zones = data.get("zones", [])
        self.exits = {e["id"]: (e["x"], e["y"]) for e in data["exits"]}
        for eid, (x, y) in self.exits.items():
            if self.cell(x, y) != EXIT:
                raise ValueError(f"exit {eid} at ({x}, {y}) is not an 'E' cell")

        self.sensors = data.get("sensors", [])
        self.victims = data.get("victims", [])
        for v in self.victims:
            if not self.walkable(v["x"], v["y"]):
                raise ValueError(f"victim {v['id']} at ({v['x']}, {v['y']}) is not on a walkable cell")
        self.hydrants = data.get("hydrants", [])
        self.gas_valves = data.get("gas_valves", [])
        self.power_cutoffs = data.get("power_cutoffs", [])
        self.demo = data.get("demo", {})

        self._zone_of = {}
        for z in self.zones:
            x1, y1, x2, y2 = z["rect"]
            for y in range(y1, y2 + 1):
                for x in range(x1, x2 + 1):
                    self._zone_of[(x, y)] = z["id"]

        self.open_cells = [(x, y) for y in range(self.h) for x in range(self.w)
                           if self.rows[y][x] != WALL]

    # --- cells ---------------------------------------------------------------

    def inside(self, x, y):
        return 0 <= x < self.w and 0 <= y < self.h

    def cell(self, x, y):
        return self.rows[y][x]

    def is_wall(self, x, y):
        return not self.inside(x, y) or self.rows[y][x] == WALL

    def walkable(self, x, y):
        return self.inside(x, y) and self.rows[y][x] in WALKABLE

    def zone_at(self, x, y):
        return self._zone_of.get((x, y))

    def zone(self, zone_id):
        for z in self.zones:
            if z["id"] == zone_id:
                return z
        return None

    def walk_neighbours(self, x, y):
        """Walkable 8-neighbours, without cutting corners. Yields (nx, ny, step_length)."""
        for dx, dy in N8:
            nx, ny = x + dx, y + dy
            if not self.walkable(nx, ny):
                continue
            if dx and dy and not (self.walkable(x + dx, y) and self.walkable(x, y + dy)):
                continue
            yield nx, ny, (1.4142 if dx and dy else 1.0)
