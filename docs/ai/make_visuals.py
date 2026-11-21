"""Slide visuals for the AI part of the pitch (slides 6 and 7), from our real results.

    python docs/ai/make_visuals.py

Writes 1920 x 1080 PNGs next to this file:
    slide6_ai_results.png   35 % -> 94 % chart + a real thermal detection
    slide7_light_enough.png model size, cheap board, speed
Numbers come from ai/results/metrics.json, ai/results/confusion_at_0.5.json and
the CPU speed test in ai/REPORT.md (section 5.5).
"""
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.image as mpimg
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch

HERE = Path(__file__).parent
ROOT = HERE.parent.parent
M = json.load(open(ROOT / "ai/results/metrics.json"))
C = json.load(open(ROOT / "ai/results/confusion_at_0.5.json"))

BG, INK, INK2, MUTED = "#111111", "#f0efec", "#c3c2b7", "#5c5b57"
ORANGE = "#d95926"          # our model (validated dark-mode accent)
GREY = "#8a8984"            # the baseline, deliberately neutral
plt.rcParams["font.family"] = ["Segoe UI", "Segoe UI Symbol"]   # Symbol: the ✓ and ✗ marks


def canvas():
    fig = plt.figure(figsize=(19.2, 10.8), dpi=100)
    fig.patch.set_facecolor(BG)
    return fig


# ---------------- slide 6: what thermal training adds ----------------
fig = canvas()
ax = fig.add_axes([0.06, 0.22, 0.40, 0.60])
ax.set_facecolor(BG)
before = M["test_baseline_yolov8n_no_thermal_training"]["mAP50"] * 100
after = M["test_our_model"]["mAP50"] * 100
bars = ax.bar([0, 1], [before, after], width=0.56, color=[GREY, ORANGE], zorder=2)
for b, v in zip(bars, (before, after)):
    ax.text(b.get_x() + b.get_width() / 2, v + 2.5, f"{v:.0f} %", ha="center", va="bottom",
            fontsize=54, color=INK, weight="bold")
ax.set_xticks([0, 1], ["Before thermal training", "Our model"], fontsize=22, color=INK2)
ax.set_ylim(0, 115)
ax.set_yticks([])
for s in ("top", "right", "left"):
    ax.spines[s].set_visible(False)
ax.spines["bottom"].set_color(MUTED)
ax.tick_params(axis="x", length=0, pad=14)
fig.text(0.06, 0.86, "Detection score on 1,317 real thermal test images (mAP@50)", fontsize=22, color=INK2)

img = mpimg.imread(ROOT / "ai/results/examples/example_1.jpg")
ax2 = fig.add_axes([0.53, 0.20, 0.42, 0.66])
ax2.imshow(img)
ax2.axis("off")
fig.text(0.53, 0.155, "A real thermal test image: 4 people found by our model", fontsize=18, color=INK2)

p, r = C["precision"] * 100, C["recall"] * 100
fig.text(0.06, 0.06, f"At the drone's threshold:  {p:.0f} % precision  ·  {r:.0f} % recall  ·  "
                     f"trained on {M['dataset']['images']:,} real thermal images",
         fontsize=20, color=INK)
fig.savefig(HERE / "slide6_ai_results.png", facecolor=BG)
plt.close(fig)


# ---------------- slide 7: light enough to fly ----------------
fig = canvas()
cards = [
    ("6.5 MB", "our model", "3.1 M parameters", ORANGE, ""),
    ("~$100", "single-board computer\non the drone", "runs it on board,\neven if the radio is lost", INK, "✓"),
    ("$500+", "dedicated AI card", "not needed", MUTED, "✗"),
]
W, H, Y, GAP = 0.27, 0.50, 0.30, 0.035
x0 = (1 - (3 * W + 2 * GAP)) / 2
for i, (big, what, sub, color, mark) in enumerate(cards):
    x = x0 + i * (W + GAP)
    fig.patches.append(FancyBboxPatch((x, Y), W, H, boxstyle="round,pad=0,rounding_size=0.015",
                                      transform=fig.transFigure, fc="#1c1c1b",
                                      ec=ORANGE if i == 0 else "#2c2c2a", lw=3 if i == 0 else 1.5))
    fig.text(x + W / 2, Y + H * 0.70, big, ha="center", va="center", fontsize=70, weight="bold", color=color)
    fig.text(x + W / 2, Y + H * 0.40, f"{mark} {what}".strip(), ha="center", va="center", fontsize=24,
             color=INK if i < 2 else INK2, weight="bold")
    fig.text(x + W / 2, Y + H * 0.16, sub, ha="center", va="center", fontsize=18, color=INK2)

fig.text(0.5, 0.86, "Small on purpose: the AI flies with the drone", ha="center", fontsize=30, color=INK2)
fig.text(0.5, 0.17, "8 images per second on an ordinary laptop processor, no graphics card",
         ha="center", fontsize=22, color=INK)
fig.text(0.5, 0.11, "Measured on an Intel laptop CPU. Speed on the target board still to be measured.",
         ha="center", fontsize=15, color=MUTED)
fig.savefig(HERE / "slide7_light_enough.png", facecolor=BG)
plt.close(fig)
print("written:", [p.name for p in HERE.glob("slide*.png")])
