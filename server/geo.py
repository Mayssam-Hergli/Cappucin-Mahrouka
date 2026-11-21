"""Outils de grille partagés par le serveur (et la FakeSim).

Coordonnées : x = colonne (0..W-1), y = ligne (0..H-1), 1 cellule = 1 m.
"""
import heapq
import math
from collections import deque

WALL = "#"
N4 = ((1, 0), (-1, 0), (0, 1), (0, -1))


class Grid:
    def __init__(self, factory):
        self.rows = factory["grid"]
        self.H = len(self.rows)
        self.W = len(self.rows[0])
        self.zones = factory.get("zones", [])
        self.exits = factory.get("exits") or self._scan_exits()
        self._zone_of = {}
        for z in self.zones:
            x0, y0, x1, y1 = z["rect"]
            for y in range(y0, y1 + 1):
                for x in range(x0, x1 + 1):
                    self._zone_of[(x, y)] = z["id"]

    def _scan_exits(self):
        out = []
        for y, row in enumerate(self.rows):
            for x, c in enumerate(row):
                if c == "E":
                    out.append({"id": f"E{len(out) + 1}", "x": x, "y": y})
        return out

    def cell(self, x, y):
        if 0 <= x < self.W and 0 <= y < self.H:
            return self.rows[y][x]
        return WALL

    def inside(self, x, y):
        return 0 <= x < self.W and 0 <= y < self.H

    def walkable(self, x, y):
        return self.cell(x, y) != WALL

    def zone_of(self, x, y):
        """Zone d'une cellule ; une porte prend la zone d'une cellule voisine."""
        z = self._zone_of.get((x, y))
        if z:
            return z
        for dx, dy in N4:
            z = self._zone_of.get((x + dx, y + dy))
            if z:
                return z
        return None

    def exit_by_id(self, eid):
        for e in self.exits:
            if e["id"] == eid:
                return e
        return self.exits[0]

    def neighbors(self, x, y):
        for dx, dy in N4:
            nx, ny = x + dx, y + dy
            if self.walkable(nx, ny):
                yield nx, ny

    # --- vision -----------------------------------------------------------
    def line_of_sight(self, x0, y0, x1, y1):
        """Bresenham : vrai si aucun mur entre les deux cellules (extrémités exclues)."""
        dx, dy = abs(x1 - x0), -abs(y1 - y0)
        sx, sy = (1 if x0 < x1 else -1), (1 if y0 < y1 else -1)
        err = dx + dy
        x, y = x0, y0
        while (x, y) != (x1, y1):
            if (x, y) != (x0, y0) and self.cell(x, y) == WALL:
                return False
            e2 = 2 * err
            if e2 >= dy:
                err += dy
                x += sx
            if e2 <= dx:
                err += dx
                y += sy
        return True

    def visible_cells(self, cx, cy, radius=3):
        """Cellules vues par la caméra thermique depuis (cx, cy)."""
        out = []
        r2 = radius * radius
        for y in range(cy - radius, cy + radius + 1):
            for x in range(cx - radius, cx + radius + 1):
                if not self.inside(x, y):
                    continue
                if (x - cx) ** 2 + (y - cy) ** 2 > r2:
                    continue
                if self.line_of_sight(cx, cy, x, y):
                    out.append((x, y))
        return out

    # --- distances & chemins --------------------------------------------
    def distance_field(self, sources, max_d=12):
        """BFS multi-sources (à travers ce qui n'est pas un mur)."""
        dist = {}
        q = deque()
        for s in sources:
            s = tuple(s)
            if s not in dist:
                dist[s] = 0
                q.append(s)
        while q:
            x, y = q.popleft()
            d = dist[(x, y)]
            if d >= max_d:
                continue
            for n in self.neighbors(x, y):
                if n not in dist:
                    dist[n] = d + 1
                    q.append(n)
        return dist

    def astar(self, start, goal, cost_fn=None, blocked=frozenset()):
        start, goal = tuple(start), tuple(goal)
        if start == goal:
            return [list(start)]
        openq = [(0, 0, start)]
        came = {start: None}
        g = {start: 0}
        i = 0
        while openq:
            _, _, cur = heapq.heappop(openq)
            if cur == goal:
                path = []
                while cur is not None:
                    path.append(list(cur))
                    cur = came[cur]
                return path[::-1]
            for n in self.neighbors(*cur):
                if n in blocked and n != goal:
                    continue
                step = 1 + (cost_fn(n) if cost_fn else 0)
                ng = g[cur] + step
                if ng < g.get(n, math.inf):
                    g[n] = ng
                    came[n] = cur
                    i += 1
                    h = abs(n[0] - goal[0]) + abs(n[1] - goal[1])
                    heapq.heappush(openq, (ng + h, i, n))
        return None


def compass_fr(dx, dy):
    """Direction en mots (y vers le bas = sud)."""
    if dx == 0 and dy == 0:
        return "ici"
    ang = math.degrees(math.atan2(-dy, dx)) % 360
    names = ["à l'est", "au nord-est", "au nord", "au nord-ouest",
             "à l'ouest", "au sud-ouest", "au sud", "au sud-est"]
    return names[int((ang + 22.5) // 45) % 8]
