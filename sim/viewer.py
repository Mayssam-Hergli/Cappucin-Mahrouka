"""Matplotlib viewer: run the whole scenario without the server.

    python -m sim.viewer                                        # live animation of the demo scenario
    python -m sim.viewer --origin 34 20 --wind 10 270 --entry E2
    python -m sim.viewer --save fire.png --steps 0 40 80 120    # snapshots side by side

Timeline: the fire starts at step 0, the forecast runs while the team drives,
the drone is launched at --launch-at, and victims "answer" the drone a few
steps after they are found (walking, injured or no answer), as the voice
script would.
"""

import argparse
import os

import numpy as np
from matplotlib.patches import Rectangle

from . import Sim
from .grid import DOOR, ELEC, EXIT, FLOOR, FUEL, GAS, PAPER, WALL

DEFAULT_MAP = os.path.join(os.path.dirname(__file__), "factory.json")

CELL_COLOURS = {
    WALL:  "#2b2b2b",
    FLOOR: "#ece8de",
    DOOR:  "#a77b4f",
    EXIT:  "#2e9e44",
    PAPER: "#d8bc8a",
    FUEL:  "#9b7bb8",
    GAS:   "#6fb7b0",
    ELEC:  "#7a8fa8",
}
VICTIM_COLOURS = {"unknown": "#ff00aa", "walking": "#2e9e44", "injured": "#e03131", "no_answer": "#f08c00"}
AUTO_ANSWERS = ["injured", "walking", "no_answer"]
ANSWER_DELAY = 6            # steps between "found" and the victim's answer (3 s)


class Scenario:
    """Drives a Sim the way the server would, for the viewer."""

    def __init__(self, args):
        self.sim = Sim(args.map, seed=args.seed)
        demo = self.sim.factory.demo
        wind = demo.get("wind", {})
        kmh, deg = args.wind or (wind.get("kmh", 0), wind.get("deg", 0))
        self.sim.set_wind(kmh, deg)
        self.sim.start_fire(*(args.origin or demo.get("origin", [20, 5])))
        self.entry = args.entry or demo.get("entry", "E1")
        self.launch_at = args.launch_at
        self.auto_voice = not args.no_voice
        self.n = 0
        self.trail = []
        self._answer_at = {}

    def step(self):
        if self.n == self.launch_at:
            self.sim.launch_drone(self.entry)
        found = self.sim.step()
        self.n += 1
        if self.sim.drone is not None:
            self.trail.append((self.sim.drone.x, self.sim.drone.y))
        if self.auto_voice:
            for vid in found:
                self._answer_at[vid] = self.n + ANSWER_DELAY
            for vid, at in list(self._answer_at.items()):
                if self.n >= at:
                    status = AUTO_ANSWERS[(int(vid[1:]) - 1) % len(AUTO_ANSWERS)]
                    self.sim.set_victim_status(vid, status)
                    del self._answer_at[vid]

    def done(self):
        d = self.sim.drone
        return d is not None and d.state == "OUT"


def _rgb(hex_colour):
    h = hex_colour.lstrip("#")
    return [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]


def render(ax, sim, clean=False, forecast=None, trail=None, title=None):
    """Draw the simulation on a matplotlib axis.

    clean: no axis ticks and no hidden victims (for slides); forecast: cells to
    outline as "fire in a few minutes"; trail: the drone's past positions;
    title: replaces the automatic status line.
    """
    f = sim.factory
    st = sim.state()
    hz = sim.hazards
    img = np.array([[_rgb(CELL_COLOURS[f.cell(x, y)]) for x in range(f.w)] for y in range(f.h)])

    def blend(cells, colour, alpha):
        c = np.array(_rgb(colour))
        for x, y in cells:
            img[y, x] = (1 - alpha) * img[y, x] + alpha * c

    if sim.drone is not None:                           # what the drone has explored
        blend([c for c in sim.drone.seen if f.cell(*c) == FLOOR], "#a5d8ff", 0.35)
    blend(st["burnt"], "#3d2b1f", 0.85)
    for (x, y) in f.open_cells:                         # smoke, by density
        s = min(hz.smoke[y][x], 1.0)
        if s > 0.05:
            img[y, x] = (1 - 0.75 * s) * img[y, x] + 0.75 * s * np.array(_rgb("#6b6b6b"))
    blend(st["gas"], "#b5d334", 0.55)
    for x, y in st["fire"]:
        img[y, x] = _rgb("#ff7a00") if (x + y + int(sim.t)) % 3 else _rgb("#e8250c")

    ax.clear()
    ax.imshow(img, interpolation="nearest")
    if clean:
        ax.set_xticks([])
        ax.set_yticks([])
    else:
        ax.set_xticks(range(0, f.w, 5))
        ax.set_yticks(range(0, f.h, 5))
        ax.tick_params(labelsize=7)

    if forecast:                                        # where the fire will be: dashed outline
        now = {tuple(c) for c in st["fire"]}
        for x, y in forecast:
            if (x, y) not in now:
                ax.add_patch(Rectangle((x - 0.5, y - 0.5), 1, 1, fill=False, edgecolor="#e8250c",
                                       linestyle=(0, (2, 2)), linewidth=0.9))
    if trail and len(trail) > 1:                        # where the drone has flown
        xs, ys = zip(*trail)
        ax.plot(xs, ys, color="#1c7ed6", linewidth=0.9, alpha=0.6)

    for z in f.zones:
        x1, y1, x2, y2 = z["rect"]
        ax.text((x1 + x2) / 2, y1 + 0.2, f"{z['id']} {z['name']}", ha="center", va="top",
                fontsize=6.5, color="#333333")
    for eid, (x, y) in f.exits.items():
        ax.text(x, y, eid, ha="center", va="center", fontsize=6, color="white", weight="bold")
    for s in f.sensors:
        ax.plot(s["x"], s["y"], marker="^", color="#1c7ed6", markersize=4)

    plans = st["plans"]
    for e in plans["evacuation"]:
        if e["path"]:
            xs, ys = zip(*e["path"])
            ax.plot(xs, ys, color="#2e9e44", linewidth=1.6, alpha=0.85)
    if plans["entry"]["path"]:
        xs, ys = zip(*plans["entry"]["path"])
        ax.plot(xs, ys, color="#1c7ed6", linewidth=2, linestyle="--")
    for line in plans["extinguish"]:
        ax.text(line["at"][0], line["at"][1], f"{line['order']}: {line['agent']} from {line['attack_from']}",
                ha="center", va="center", fontsize=7, weight="bold", color="white",
                bbox=dict(boxstyle="round,pad=0.2", fc="#c92a2a", ec="none"))

    for v in st["victims"]:
        if v["found"]:
            ax.plot(v["x"], v["y"], marker="o", color=VICTIM_COLOURS.get(v["status"], "#ff00aa"),
                    markersize=7, markeredgecolor="black")
            ax.text(v["x"] + 0.6, v["y"] - 0.6, v["id"], fontsize=6.5, weight="bold")
        elif not clean:     # hidden victims: shown only when debugging
            ax.plot(v["x"], v["y"], marker="o", markerfacecolor="none", markeredgecolor="#888888", markersize=5)

    auto = f"t = {st['t']:.0f} s   fire {len(st['fire'])}   wind {st['wind']['kmh']:.0f} km/h toward {st['wind']['deg']:.0f}°"
    if st["drone"]:
        d = st["drone"]
        ax.plot(d["x"], d["y"], marker="D", color="#1c7ed6", markersize=7, markeredgecolor="white")
        auto += f"   drone {d['state']} {d['temp']:.0f} °C"
    if plans["entry"]["door"]:
        auto += f"   entry {plans['entry']['door']}"
    ax.set_title(title or auto, fontsize=10 if title else 8, weight="bold" if title else "normal")


def main():
    p = argparse.ArgumentParser(description="Run the factory fire scenario without the server.")
    p.add_argument("--map", default=DEFAULT_MAP)
    p.add_argument("--origin", type=int, nargs=2, metavar=("X", "Y"), help="fire origin")
    p.add_argument("--wind", type=float, nargs=2, metavar=("KMH", "DEG"), help="speed and direction it blows toward")
    p.add_argument("--entry", help="exit door the drone enters by (E1, E2, E3)")
    p.add_argument("--launch-at", type=int, default=20, help="step at which the drone is launched")
    p.add_argument("--no-voice", action="store_true", help="victims never answer")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--steps", type=int, nargs="+", default=[0, 40, 80, 120],
                   help="with --save: the steps to show side by side")
    p.add_argument("--save", metavar="PNG", help="save snapshots instead of animating")
    args = p.parse_args()

    import matplotlib
    if args.save:
        matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    sc = Scenario(args)

    if args.save:
        steps = sorted(args.steps)
        cols = min(2, len(steps))
        rows = (len(steps) + cols - 1) // cols
        fig, axes = plt.subplots(rows, cols, figsize=(7.5 * cols, 5 * rows), squeeze=False)
        for ax, target in zip(axes.flat, steps):
            while sc.n < target:
                sc.step()
            render(ax, sc.sim)
        for ax in list(axes.flat)[len(steps):]:
            ax.axis("off")
        fig.tight_layout()
        fig.savefig(args.save, dpi=130)
        print(f"saved {args.save}")
        return

    from matplotlib.animation import FuncAnimation
    fig, ax = plt.subplots(figsize=(10, 6.5))

    def update(_):
        if not sc.done():
            sc.step()
        render(ax, sc.sim)

    render(ax, sc.sim)
    _anim = FuncAnimation(fig, update, interval=100, cache_frame_data=False)
    plt.show()


if __name__ == "__main__":
    main()
