"""Safest paths on the factory grid.

The cost of entering a cell is

    cost = 1 + W_HEAT * heat + W_SMOKE * smoke + W_GAS * gas

so a path prefers a longer detour to a short walk through heat, smoke or gas.
Burning cells are blocked. Moves go in 8 directions without cutting corners.

- astar(): one start, one goal (octile-distance heuristic).
- safest_to_any(): one start, several possible goals (for example every exit);
  returns the goal that is cheapest to reach. This is A* with a zero heuristic.
- cost_map(): the cost from one start to every reachable cell, to compare doors.
"""

import heapq
import math

W_HEAT = 4.0
W_SMOKE = 3.0
W_GAS = 6.0

INF = math.inf


def cell_cost(hz, x, y):
    return 1.0 + W_HEAT * hz.heat_at(x, y) + W_SMOKE * hz.smoke[y][x] + W_GAS * hz.gas[y][x]


def _neighbours(f, hz, x, y):
    for nx, ny, length in f.walk_neighbours(x, y):
        if (nx, ny) not in hz.burning:
            yield nx, ny, length * cell_cost(hz, nx, ny)


def _rebuild(prev, end):
    path = [end]
    while path[-1] in prev:
        path.append(prev[path[-1]])
    path.reverse()
    return [[x, y] for x, y in path]


def astar(f, hz, start, goal):
    """Safest path from start to goal. Returns (path, cost), or (None, inf) if unreachable."""
    start, goal = tuple(start), tuple(goal)
    gx, gy = goal

    def h(x, y):
        dx, dy = abs(x - gx), abs(y - gy)
        return max(dx, dy) + (math.sqrt(2) - 1) * min(dx, dy)

    best = {start: 0.0}
    prev = {}
    heap = [(h(*start), 0.0, start)]
    while heap:
        _, g, cur = heapq.heappop(heap)
        if cur == goal:
            return _rebuild(prev, cur), g
        if g > best.get(cur, INF):
            continue
        for nx, ny, step in _neighbours(f, hz, *cur):
            ng = g + step
            if ng < best.get((nx, ny), INF):
                best[(nx, ny)] = ng
                prev[(nx, ny)] = cur
                heapq.heappush(heap, (ng + h(nx, ny), ng, (nx, ny)))
    return None, INF


def safest_to_any(f, hz, start, is_goal):
    """Cheapest path from start to any cell where is_goal(x, y) is true.

    Returns (goal, path, cost), or (None, None, inf) if no goal is reachable.
    """
    start = tuple(start)
    best = {start: 0.0}
    prev = {}
    heap = [(0.0, start)]
    while heap:
        g, cur = heapq.heappop(heap)
        if g > best.get(cur, INF):
            continue
        if is_goal(*cur):
            return cur, _rebuild(prev, cur), g
        for nx, ny, step in _neighbours(f, hz, *cur):
            ng = g + step
            if ng < best.get((nx, ny), INF):
                best[(nx, ny)] = ng
                prev[(nx, ny)] = cur
                heapq.heappush(heap, (ng, (nx, ny)))
    return None, None, INF


def cost_map(f, hz, start):
    """Cost from start to every reachable cell. Returns (cost, prev); use path_to() to read a path."""
    start = tuple(start)
    best = {start: 0.0}
    prev = {}
    heap = [(0.0, start)]
    while heap:
        g, cur = heapq.heappop(heap)
        if g > best.get(cur, INF):
            continue
        for nx, ny, step in _neighbours(f, hz, *cur):
            ng = g + step
            if ng < best.get((nx, ny), INF):
                best[(nx, ny)] = ng
                prev[(nx, ny)] = cur
                heapq.heappush(heap, (ng, (nx, ny)))
    return best, prev


def path_to(prev, best, end):
    end = tuple(end)
    if end not in best:
        return None
    return _rebuild(prev, end)
