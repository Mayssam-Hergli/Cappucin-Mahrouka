# Confusion matrix at the drone's real operating threshold (conf >= 0.5).
# Paste into ONE new Colab cell after evaluate.py.
#
# Why: Ultralytics draws its default confusion matrix with every guess, down to 0.1 %
# confidence (needed to compute mAP), so it shows ~20,000 "false persons" that the drone
# would never report. The drone only reports a person at conf >= 0.5, so this is the
# matrix that describes its real behaviour.
import glob
import json
import shutil

from google.colab import files
from ultralytics.models.yolo.detect import DetectionValidator

RUN = "/content/drive/MyDrive/aeroday/thermal_person"
OUT = f"{RUN}/report"

v = DetectionValidator(args=dict(model=f"{RUN}/weights/best.pt", data="/content/thermal_yolo/dataset.yaml",
                                 split="test", conf=0.5, plots=True,
                                 project=RUN, name="test_conf05", exist_ok=True))
v()
m = v.confusion_matrix.matrix          # rows = predicted, columns = true; last = background
tp, fp, fn = int(m[0, 0]), int(m[0, -1]), int(m[-1, 0])
result = {"conf_threshold": 0.5, "true_positives": tp, "false_positives": fp, "false_negatives": fn,
          "precision": round(tp / (tp + fp), 4), "recall": round(tp / (tp + fn), 4)}
print(json.dumps(result, indent=2))

with open(f"{OUT}/confusion_at_0.5.json", "w") as f:
    json.dump(result, f, indent=2)
for png in glob.glob(f"{v.save_dir}/confusion_matrix*.png"):
    dst = f"{OUT}/" + png.split("/")[-1].replace("confusion_matrix", "confusion_matrix_conf0.5")
    shutil.copy(png, dst)
    files.download(dst)
files.download(f"{OUT}/confusion_at_0.5.json")
