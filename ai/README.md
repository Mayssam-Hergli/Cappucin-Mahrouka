# ai/: thermal person detector

A YOLOv8n model fine-tuned on 8,778 real thermal images labelled "person".

**Test set (1,317 images), at the drone's threshold (confidence ≥ 0.5): precision 94.1 %, recall 82.9 %. mAP@50: 93.8 %** (35 % before thermal training). Full details in [`REPORT.md`](REPORT.md).

## Contents

| Item | Role |
|---|---|
| `REPORT.md` | **Model report:** goal, architecture, why this model, dataset, training, results, limits, next steps |
| `train.ipynb` | Training notebook (Google Colab, T4 GPU), with the real outputs of the run |
| `evaluate.py` | Evaluation cell: test metrics, baseline, size, CPU speed, example detections |
| `confusion_at_0.5.py` | Confusion matrix at the drone's threshold (confidence 0.5) |
| `weights/best.pt` | Final trained weights (6.5 MB) |
| `results/` | Metrics (`metrics.json`, `confusion_at_0.5.json`), confusion matrices, curves, training log, 5 example detections |

## Use it

```python
from ultralytics import YOLO
model = YOLO("ai/weights/best.pt")
model.predict("thermal_image.jpg", conf=0.5, save=True)
```
