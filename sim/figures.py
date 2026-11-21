"""Slide images for the simulation.

    python -m sim.figures                       # writes docs/simulation/*.png
    python -m sim.figures --out some/folder

Plays the demo scenario (factory.json "demo") and captures three moments:
  1. the fire forecast while the team drives,
  2. the drone exploring and finding people,
  3. the three plans when the drone is out.
Writes one 16:9 image with the three moments and a legend, plus each moment
alone, and prints the numbers to quote on the slide.
"""

import argparse
import os
from types import SimpleNamespace

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt                       # noqa: E402
from matplotlib.lines import Line2D                   # noqa: E402
from matplotlib.patches import Patch                  # noqa: E402

from .viewer import DEFAULT_MAP, VICTIM_COLOURS, Scenario, render   # noqa: E402

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FORECAST_MIN = 5
FOUND_FOR_PANEL_2 = 3

TITLES = (
    "1. While the team drives: fire now + forecast in {m} min",
    "2. The drone explores and finds people",
    "3. Three plans for the commander",
)


def legend_handles():
    def patch(colour, label, **kw):
        return Patch(facecolor=colour, label=label, **kw)

    def marker(colour, label, shape="o", **kw):
        return Line2D([], [], marker=shape, linestyle="none", markerfacecolor=colour,
                      markeredgecolor=kw.pop("edge", "black"), markersize=8, label=label)

    return [
        patch("#ff7a00", "fire"),
        Patch(facecolor="none", edgecolor="#e8250c", linestyle="--", label=f"fire in {FORECAST_MIN} min"),
        patch("#3d2b1f", "burnt out"),
        patch("#8a8a8a", "smoke"),
        patch("#d6e6f0", "explored by the drone"),
        marker("#1c7ed6", "drone", shape="D", edge="white"),
        marker(VICTIM_COLOURS["injured"], "victim: injured"),
        marker(VICTIM_COLOURS["walking"], "victim: can walk"),
        marker(VICTIM_COLOURS["no_answer"], "victim: no answer"),
        marker(VICTIM_COLOURS["unknown"], "victim: being spoken to"),
        Line2D([], [], color="#2e9e44", linewidth=2, label="evacuation path"),
        Line2D([], [], color="#1c7ed6", linewidth=2, linestyle="--", label="firefighters' entry"),
        patch("#c92a2a", "attack: order, agent, side"),
    ]


def main():
    p = argparse.ArgumentParser(description="Write the simulation slide images.")
    p.add_argument("--out", default=os.path.join(REPO_ROOT, "docs", "simulation"))
    args = p.parse_args()
    os.makedirs(args.out, exist_ok=True)

    sc = Scenario(SimpleNamespace(map=DEFAULT_MAP, seed=42, wind=None, origin=None, entry=None,
                                  launch_at=20, no_voice=False))
    sim = sc.sim
    titles = [TITLES[0].format(m=FORECAST_MIN), TITLES[1], TITLES[2]]

    story, axes = plt.subplots(1, 3, figsize=(16, 4.6))
    singles = []
    facts = {}

    def capture(i, **kw):
        render(axes[i], sim, clean=True, title=titles[i], **kw)
        fig, ax = plt.subplots(figsize=(8, 5.4))
        render(ax, sim, clean=True, title=titles[i], **kw)
        fig.tight_layout()
        singles.append(fig)

    # 1. forecast, just before the drone is launched
    while sc.n < sc.launch_at:
        sc.step()
    fc = sim.forecast(FORECAST_MIN)
    facts["fire_now_m2"] = len(sim.state()["fire"])
    facts["fire_forecast_m2"] = len(fc["fire"])
    capture(0, forecast=fc["fire"])

    # 2. the drone has found a few people
    while sum(v["found"] for v in sim.victims) < FOUND_FOR_PANEL_2 and not sc.done():
        sc.step()
    capture(1, trail=sc.trail)

    # 3. the drone is out: plans ready
    max_temp = 0.0
    while not sc.done():
        sc.step()
        max_temp = max(max_temp, sim.drone.temp)
        if sim.drone.return_reason and "return_at_s" not in facts:
            facts["return_at_s"] = (sc.n - sc.launch_at) * 0.5
            facts["return_temp"] = round(sim.drone.temp, 1)
    for _ in range(20):         # let one look-ahead test run on the final situation
        sc.step()
    capture(2, trail=sc.trail)

    st = sim.state()
    facts["drone_flight_s_real"] = (sc.n - sc.launch_at) * 0.5
    facts["victims_found"] = sum(v["found"] for v in st["victims"])
    facts["victims_total"] = len(st["victims"])
    facts["rescue_first"] = [e["victim"] for e in st["plans"]["evacuation"] if e["rescue_first"]]
    facts["entry_door"] = st["plans"]["entry"]["door"]
    facts["extinguish"] = st["plans"]["extinguish"]

    story.legend(handles=legend_handles(), loc="lower center", ncol=7, fontsize=9, frameon=False)
    story.tight_layout(rect=(0, 0.13, 1, 1))
    story.savefig(os.path.join(args.out, "simulation_story.png"), dpi=150)
    for i, fig in enumerate(singles, 1):
        fig.savefig(os.path.join(args.out, f"simulation_step{i}.png"), dpi=150)

    print(f"saved to {args.out}")
    for k, v in facts.items():
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
