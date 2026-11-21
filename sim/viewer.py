"""Matplotlib viewer: run the simulation without the server.

    python -m sim.viewer                              # live animation of the demo scenario
    python -m sim.viewer --origin 22 3 --wind 15 90   # choose the fire origin and the wind
    python -m sim.viewer --save fire.png --steps 0 30 80 150   # snapshots side by side
"""

import argparse
import os

import numpy as np

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


def _rgb(hex_colour):
    h = hex_colour.lstrip("#")
    return [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]


def render(ax, sim):
    f = sim.factory
    st = sim.state()
    img = np.array([[_rgb(CELL_COLOURS[f.cell(x, y)]) for x in range(f.w)] for y in range(f.h)])

    def blend(cells, colour, alpha):
        c = np.array(_rgb(colour))
        for x, y in cells:
            img[y, x] = (1 - alpha) * img[y, x] + alpha * c

    hz = sim.hazards
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
    ax.set_xticks(range(0, f.w, 5))
    ax.set_yticks(range(0, f.h, 5))
    ax.tick_params(labelsize=7)

    for z in f.zones:
        x1, y1, x2, y2 = z["rect"]
        ax.text((x1 + x2) / 2, y1 + 0.2, f"{z['id']} {z['name']}", ha="center", va="top",
                fontsize=6.5, color="#333333")
    for eid, (x, y) in f.exits.items():
        ax.text(x, y, eid, ha="center", va="center", fontsize=6, color="white", weight="bold")
    for s in f.sensors:
        ax.plot(s["x"], s["y"], marker="^", color="#1c7ed6", markersize=4)
    for v in st["victims"]:
        colour = VICTIM_COLOURS.get(v["status"], "#ff00aa")
        if v["found"]:
            ax.plot(v["x"], v["y"], marker="o", color=colour, markersize=6, markeredgecolor="black")
        else:
            ax.plot(v["x"], v["y"], marker="o", markerfacecolor="none", markeredgecolor="#888888", markersize=5)
    if st["drone"]:
        d = st["drone"]
        ax.plot(d["x"], d["y"], marker="D", color="#1c7ed6", markersize=6, markeredgecolor="white")

    w = st["wind"]
    ax.set_title(f"t = {st['t']:.0f} s   fire {len(st['fire'])}   smoke {len(st['smoke'])}   "
                 f"gas {len(st['gas'])}   wind {w['kmh']:.0f} km/h toward {w['deg']:.0f}°", fontsize=8)


def build_sim(args):
    sim = Sim(args.map, seed=args.seed)
    demo = sim.factory.demo
    origin = args.origin or demo.get("origin", [20, 5])
    kmh, deg = args.wind or (demo.get("wind", {}).get("kmh", 0), demo.get("wind", {}).get("deg", 0))
    sim.set_wind(kmh, deg)
    sim.start_fire(*origin)
    return sim


def main():
    p = argparse.ArgumentParser(description="Run the factory fire simulation without the server.")
    p.add_argument("--map", default=DEFAULT_MAP)
    p.add_argument("--origin", type=int, nargs=2, metavar=("X", "Y"))
    p.add_argument("--wind", type=float, nargs=2, metavar=("KMH", "DEG"))
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--steps", type=int, nargs="+", default=[0, 30, 80, 150],
                   help="with --save: the steps to show side by side")
    p.add_argument("--save", metavar="PNG", help="save snapshots instead of animating")
    args = p.parse_args()

    import matplotlib
    if args.save:
        matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    sim = build_sim(args)

    if args.save:
        steps = sorted(args.steps)
        cols = min(2, len(steps))
        rows = (len(steps) + cols - 1) // cols
        fig, axes = plt.subplots(rows, cols, figsize=(7.5 * cols, 5 * rows), squeeze=False)
        done = 0
        for ax, target in zip(axes.flat, steps):
            while done < target:
                sim.step()
                done += 1
            render(ax, sim)
        for ax in list(axes.flat)[len(steps):]:
            ax.axis("off")
        fig.tight_layout()
        fig.savefig(args.save, dpi=130)
        print(f"saved {args.save}")
        return

    from matplotlib.animation import FuncAnimation
    fig, ax = plt.subplots(figsize=(10, 6.5))

    def update(_):
        sim.step()
        render(ax, sim)

    render(ax, sim)
    _anim = FuncAnimation(fig, update, interval=100, cache_frame_data=False)
    plt.show()


if __name__ == "__main__":
    main()
