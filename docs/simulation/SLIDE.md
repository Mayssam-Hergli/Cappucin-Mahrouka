# Simulation slide

Images in this folder (regenerate with `python -m sim.figures` after any change to `sim/`):

| File | Use |
|---|---|
| `simulation_story.png` | The slide's main visual: the three moments side by side, with a legend (16:9) |
| `simulation_step1.png` … `step3.png` | Each moment alone, for a build-up animation or the video |

---

## Slide content

**Title:** A physical simulation behind every recommendation

**Visual:** `simulation_story.png`, full width.

**Three points under the image:**

1. **Fire, smoke and gas follow physics on the factory map.** Fire spreads cell by cell by material (paper, solvent, gas bottles, electrical) and wind; walls stop it, doors slow it, radiant heat jumps aisles. Smoke fills rooms; gas leaks from heated bottles.
2. **The scout drone finds people, and protects itself.** It explores while avoiding heat, sees people within 3 m with its thermal camera, talks to them, and flies out on its own at **60 °C**.
3. **The plans are tested before they are recommended.** Safest exit for each victim (A*, avoiding heat, smoke and gas), the best door for the firefighters, and an attack plan simulated **3 minutes ahead** for each option.

**Key numbers (from the demo run):**

| | |
|---|---|
| Fire forecast while driving | 34 m² now → **56 m² in 5 min** |
| Victims found by the drone | **5 / 5**, 3 flagged *rescue first* |
| Drone return | **60.8 °C**, flew out by itself |
| Attack tested 3 min ahead | **56 m² of fire with no action → 11 m² with the recommended attack** |

**Footer:** The AI recommends, the commander decides.

---

## Speaker notes (about 30 s)

> Everything you see on the dashboard comes from a physical simulation of the factory. When the alarm is confirmed, it forecasts where the fire is heading while the team drives: here, from 34 to 56 square metres in five minutes.
> Inside, the drone explores the building, finds the five workers with its thermal camera, talks to them, and when it reaches 60 degrees near the fire it flies out on its own.
> Then the system gives three plans. And the attack plan is not a guess: we simulate each option three minutes ahead and keep the one that leaves the least fire near the victims. Here, attacking from the west cuts the fire from 56 to 11 square metres.
> The AI recommends; the commander decides.

---

## Jury questions on the simulation

| Question | Answer |
|---|---|
| Is the fire model realistic? | It is a cellular automaton, a standard method for fire spread. It uses material flammability, burn time, wind, walls, doors and radiant heat. It is not yet calibrated on real fire data: the real product refines it with fire data and with the Protection Civile. |
| There is no GPS indoors. | The drone already has the factory map and follows it with its motion sensors. Our simulation moves it on that map. |
| Won't the drone burn? | It is a scout: it avoids heat in its route, stays away from flames, and leaves by itself at 60 °C. If lost, it costs far less than a life. |
| What if a victim can't answer? | No answer = flagged *rescue first* in the evacuation plan. |
| Why this attack side? | The rule allows only the sides upwind and away from the victims; then the simulator tests each of them 3 minutes ahead and keeps the safest. |
| How fast is the demo? | The demo is accelerated 4 times: 1 step every 0.5 s = 2 s of simulated time. The drone flies at 1 m/s. |
