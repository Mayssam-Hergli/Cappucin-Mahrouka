# AI slides (6 and 7)

Images in this folder, 1920 × 1080, dark thermal style. Regenerate with `python docs/ai/make_visuals.py`; every number comes from `ai/results/`.

| File | Slide |
|---|---|
| `slide6_ai_results.png` | 6: what thermal training adds, plus a real detection |
| `slide7_light_enough.png` | 7: model size and cheap hardware |

---

## Slide 6

**Title:** Our AI finds people in heat, not light

**Visual:** `slide6_ai_results.png`, full width.

**Small footnote:** *Live demo: a webcam stands in for the thermal camera. The model is trained and tested on real thermal images.*

**Speaker (Israa, 40 s):** "Smoke blinds normal cameras, so our drone sees heat. We trained a small AI on 8,778 real thermal images. The same model before training scored 35 % on thermal images; ours scores 94 %. When it says *person*, it's right 94 times out of 100. In the live demo a webcam stands in for the thermal camera, but every number you see here is measured on real thermal images the model had never seen."

## Slide 7

**Title:** Light enough to fly

**Visual:** `slide7_light_enough.png`, full width.

**Speaker (Israa, 20 s):** "We chose a 6.5 MB model on purpose. It runs on a computer of about 100 dollars on the drone itself, so it keeps finding people even if the radio is cut inside the building. No expensive AI card needed."

## If the jury asks

| Question | Answer |
|---|---|
| Is your thermal camera real? | Not in the demo: the webcam stands in. The model is trained and tested on real thermal images. |
| Smoke blinds cameras. | Thermal cameras see body heat through smoke; that is why we trained on thermal images. |
| How many people do you miss? | About 1 in 6 in a single image. The drone films continuously, so each person gets many chances. Measuring that is our next step. |
| Why not a bigger model? | It would need an expensive card and more battery. 6.5 MB runs on a ~$100 board. |
| What are the limits? | The dataset has no fire scenes yet, and the images are split at random. Next: fire-scene data and a test with a real thermal camera. |
