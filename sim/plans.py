"""The three plans: evacuation, entry and extinguishing.

The plans are recommendations for the commander, recomputed at every step from
the current fire, smoke, gas and the victims found so far.

Evacuation
    For each victim found: the safest path to an exit (lowest A* cost, not
    simply the nearest). A victim who is injured, gave no answer, or has not
    answered yet is flagged rescue_first, and so is a victim with no safe way out.

Entry
    The exit door whose paths to all the victims found are the safest in total.
    The path shown goes to the first victim to reach (rescue_first, then the
    cheapest). With no victim found yet, the path goes to the edge of the fire.

Extinguishing
    One line per burning zone, with "at" = a burning cell near the middle of
    the fire, where the dashboard can draw the order number:
    - fire class from what is burning: gas bottles C, solvent B, electrical,
      otherwise A (paper, wood, debris);
    - agent: A water, B foam, C powder, electrical CO2;
    - "first": close the gas valve if gas bottles burn or are next to the fire,
      cut the power if an electrical cabinet does;
    - attack_from: the rule allows the sides (N, S, E, W) that are upwind (wind
      at the firefighters' back) or neutral, and away from any victim close to
      the fire (same zone or within VICTIM_NEAR cells). Among those, the
      look-ahead simulates LOOKAHEAD_MIN minutes on a copy for each side, and for
      no attack, and keeps the side that leaves the least fire near the victims
      and their evacuation paths. "lookahead" reports the numbers;
      it is null until the first test has run;
    - order: first the fires that threaten a victim or an evacuation path,
      then the zones with solvent or gas (explosion risk), then the largest.
"""

import copy
import math

from .grid import ELEC, FUEL, GAS, N8, PAPER, STOCK
from .pathfinding import INF, cost_map, path_to, safest_to_any

CLASS_OF = {GAS: "C", FUEL: "B", ELEC: "electrical", PAPER: "A"}
AGENT = {"A": "water", "B": "foam", "C": "powder", "electrical": "CO2"}
SEVERITY = ("C", "B", "electrical", "A")    # worst first
SIDES = {"N": (0, -1), "S": (0, 1), "E": (1, 0), "W": (-1, 0)}

THREAT_RADIUS = 2           # cells: a fire this close to a victim or a path threatens it
UNREACHABLE_COST = 1000.0   # entry plan: penalty for a victim that cannot be reached from a door
WIND_REF_KMH = 30.0
VICTIM_WEIGHT = 1.0
VICTIM_NEAR = 6             # cells: victims this close to a fire decide which side to attack from

LOOKAHEAD_MIN = 3           # minutes simulated ahead to test each attack option
LOOKAHEAD_EVERY = 20        # steps between two tests (10 s of real time), or sooner if the situation changes
SUPPRESS_RATE = 0.5         # burning cells one attack team knocks down per step (0.25 m²/s)


def empty():
    return {"evacuation": [], "entry": {"door": None, "path": []}, "extinguish": []}


def compute(f, hz, victims, tested=None):
    """All three plans. `tested` is the latest result of test_attacks(), if any."""
    found = [v for v in victims if v["found"]]
    evacuation = evacuation_plan(f, hz, found)
    return {
        "evacuation": evacuation,
        "entry": entry_plan(f, hz, found),
        "extinguish": extinguish_plan(f, hz, found, evacuation, tested),
    }


# --- evacuation -------------------------------------------------------------

def evacuation_plan(f, hz, found):
    exit_at = {cell: eid for eid, cell in f.exits.items()}
    plan = []
    for v in found:
        goal, path, _ = safest_to_any(f, hz, (v["x"], v["y"]), lambda x, y: (x, y) in exit_at)
        plan.append({
            "victim": v["id"],
            "path": path or [],
            "exit": exit_at.get(goal),
            "rescue_first": v["status"] != "walking" or goal is None,
        })
    plan.sort(key=lambda p: not p["rescue_first"])
    return plan


# --- entry ------------------------------------------------------------------

def entry_plan(f, hz, found):
    if found:
        targets = [(v["x"], v["y"]) for v in found]
        walking = {(v["x"], v["y"]) for v in found if v["status"] == "walking"}
    else:
        targets = _fire_edge(f, hz)
        walking = set()
        if not targets:
            return {"door": None, "path": []}

    best = None
    for eid, door in f.exits.items():
        cost, prev = cost_map(f, hz, door)
        if found:
            total = sum(cost.get(t, UNREACHABLE_COST) for t in targets)
            first = min(targets, key=lambda t: (t in walking, cost.get(t, INF)))
        else:
            reachable = [t for t in targets if t in cost]
            if not reachable:
                continue
            first = min(reachable, key=lambda t: cost[t])
            total = cost[first]
        if best is None or total < best[0]:
            best = (total, eid, path_to(prev, cost, first))

    if best is None:
        return {"door": None, "path": []}
    return {"door": best[1], "path": best[2] or []}


def _fire_edge(f, hz):
    edge = set()
    for (x, y) in hz.burning:
        for dx, dy in N8:
            c = (x + dx, y + dy)
            if f.walkable(*c) and c not in hz.burning:
                edge.add(c)
    return sorted(edge)


# --- extinguishing ----------------------------------------------------------

def extinguish_plan(f, hz, found, evacuation, tested=None):
    tested = tested or {}
    by_zone = _fires_by_zone(f, hz)

    protected = {(v["x"], v["y"]) for v in found}
    for p in evacuation:
        protected.update(tuple(c) for c in p["path"])

    lines = []
    for zone, cells in by_zone.items():
        burning_classes = {CLASS_OF[f.cell(x, y)] for (x, y) in cells if f.cell(x, y) in CLASS_OF}
        nearby = _threatened_stock(f, hz, cells, zone)
        fire_class = next((c for c in SEVERITY if c in burning_classes), "A")

        first = []
        if GAS in nearby or "C" in burning_classes:
            first.append(_named("close the gas valve", f.gas_valves, zone))
        if ELEC in nearby or "electrical" in burning_classes:
            first.append(_named("cut the power", f.power_cutoffs, zone))

        threat = any(_near(c, protected) for c in cells)
        explosive = bool({"B", "C"} & burning_classes) or bool({FUEL, GAS} & nearby)
        cx = sum(x for x, _ in cells) / len(cells)
        cy = sum(y for _, y in cells) / len(cells)
        at = min(cells, key=lambda c: (c[0] - cx) ** 2 + (c[1] - cy) ** 2)
        near_victims = _victims_near(f, cells, zone, found)
        test = tested.get(zone)
        if test and test["attack_from"] in _allowed_sides(hz, cells, near_victims):
            side, lookahead = test["attack_from"], test["lookahead"]
        else:   # not tested yet, or the situation changed since: use the rule alone
            side, lookahead = _attack_side(hz, cells, near_victims), None
        lines.append({
            "zone": zone,
            "at": [at[0], at[1]],
            "fire_class": fire_class,
            "agent": AGENT[fire_class],
            "attack_from": side,
            "first": first,
            "lookahead": lookahead,
            "_key": (not threat, not explosive, -len(cells)),
        })

    lines.sort(key=lambda l: l["_key"])
    for i, line in enumerate(lines, 1):
        del line["_key"]
        line["order"] = i
    return lines


def _threatened_stock(f, hz, cells, zone):
    """Materials of the unburnt stock within THREAT_RADIUS of the fire, in the same zone."""
    found = set()
    for (x, y) in cells:
        for dx in range(-THREAT_RADIUS, THREAT_RADIUS + 1):
            for dy in range(-THREAT_RADIUS, THREAT_RADIUS + 1):
                c = (x + dx, y + dy)
                if (f.inside(*c) and f.cell(*c) in STOCK and c not in hz.burnt
                        and f.zone_at(*c) == zone):
                    found.add(f.cell(*c))
    return found


def _near(cell, cells):
    x, y = cell
    return any((x + dx, y + dy) in cells
               for dx in range(-THREAT_RADIUS, THREAT_RADIUS + 1)
               for dy in range(-THREAT_RADIUS, THREAT_RADIUS + 1))


def _victims_near(f, cells, zone, found):
    """Victims the attack must protect: in the burning zone, or within VICTIM_NEAR cells of the fire."""
    return [v for v in found
            if f.zone_at(v["x"], v["y"]) == zone
            or min(max(abs(v["x"] - x), abs(v["y"] - y)) for x, y in cells) <= VICTIM_NEAR]


def _attack_side(hz, cells, found):
    scores = _side_scores(hz, cells, found)
    return max(SIDES, key=scores.get)


def _allowed_sides(hz, cells, found):
    """Sides the rule allows: not downwind, not on the victims' side (score >= 0)."""
    scores = _side_scores(hz, cells, found)
    return sorted((s for s in SIDES if scores[s] >= -1e-9), key=lambda s: -scores[s])


def _side_scores(hz, cells, found):
    cx = sum(x for x, _ in cells) / len(cells)
    cy = sum(y for _, y in cells) / len(cells)
    wx, wy = hz.wind_vector()
    strength = min(hz.wind_kmh / WIND_REF_KMH, 1.0)

    vx = vy = 0.0
    if found:
        vx = sum(v["x"] for v in found) / len(found) - cx
        vy = sum(v["y"] for v in found) / len(found) - cy
        norm = math.hypot(vx, vy)
        if norm:
            vx, vy = vx / norm, vy / norm

    def score(side):
        nx, ny = SIDES[side]
        upwind = -(nx * wx + ny * wy) * strength      # wind at the firefighters' back
        away = -(nx * vx + ny * vy) * VICTIM_WEIGHT    # on the side away from the victims
        return upwind + away

    return {s: score(s) for s in SIDES}


# --- look-ahead: test each attack option on a copy ---------------------------

def _fires_by_zone(f, hz):
    by_zone = {}
    for (x, y) in hz.burning:
        z = f.zone_at(x, y)
        if z:
            by_zone.setdefault(z, []).append((x, y))
    return by_zone


def _danger_cells(f, found, evacuation):
    """Cells within THREAT_RADIUS of a victim or of an evacuation path."""
    protected = {(v["x"], v["y"]) for v in found}
    for p in evacuation:
        protected.update(tuple(c) for c in p["path"])
    danger = set()
    for (x, y) in protected:
        for dx in range(-THREAT_RADIUS, THREAT_RADIUS + 1):
            for dy in range(-THREAT_RADIUS, THREAT_RADIUS + 1):
                if f.inside(x + dx, y + dy):
                    danger.add((x + dx, y + dy))
    return danger


def _run_option(f, base, danger, steps, zone=None, side=None):
    """Run the fire `steps` ahead on a copy, with one attack team on `zone` from `side`
    (or no attack). Returns (fire near victims at the end, summed over time, total fire)."""
    hz = copy.deepcopy(base, {id(f): f})
    nx, ny = SIDES[side] if side else (0, 0)
    near_over_time = fire_over_time = 0
    capacity = 0.0
    for _ in range(steps):
        if zone:
            capacity += SUPPRESS_RATE
            front = [c for c in hz.burning if f.zone_at(*c) == zone]
            front.sort(key=lambda c: -(c[0] * nx + c[1] * ny))   # the cells nearest the team first
            while capacity >= 1 and front:
                hz.extinguish(*front.pop(0))
                capacity -= 1
        hz.step(smoke=False, heat=False)
        near_over_time += sum(1 for c in hz.burning if c in danger)
        fire_over_time += len(hz.burning)
    near = sum(1 for c in hz.burning if c in danger)
    return (near, near_over_time, fire_over_time), near, len(hz.burning)


def test_attacks(f, hz, victims, evacuation, dt):
    """For each burning zone, simulate LOOKAHEAD_MIN minutes ahead: no attack, and one
    attack team from each side the rule allows. Keep the side that leaves the least
    fire near the victims and their paths at the end, then the least fire near
    them over the whole period, then the least fire overall over the period.

    `hz` must be a private copy (it is not changed). Returns
    {zone: {"attack_from", "lookahead": {...}}}.
    """
    found = [v for v in victims if v["found"]]
    danger = _danger_cells(f, found, evacuation)
    steps = int(LOOKAHEAD_MIN * 60 / dt)
    _, no_near, no_total = _run_option(f, hz, danger, steps)

    results = {}
    for zone, cells in _fires_by_zone(f, hz).items():
        allowed = _allowed_sides(hz, cells, _victims_near(f, cells, zone, found))
        options = []
        for rank, side in enumerate(allowed):
            score, near, total = _run_option(f, hz, danger, steps, zone, side)
            options.append((score + (rank,), side, near, total))
        _, side, near, total = min(options)
        results[zone] = {
            "attack_from": side,
            "lookahead": {
                "minutes": LOOKAHEAD_MIN,
                "sides_tested": allowed,
                "fire_near_victims": {"no_action": no_near, "with_attack": near},
                "fire_m2": {"no_action": no_total, "with_attack": total},
            },
        }
    return results


def _named(action, devices, zone):
    for d in devices:
        if d.get("zone") == zone:
            return f"{action} {d['id']}"
    return f"{action} {devices[0]['id']}" if devices else action
