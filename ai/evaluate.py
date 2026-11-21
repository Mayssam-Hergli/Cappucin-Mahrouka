# Evaluation of the thermal person detector. Paste this whole file into ONE new Colab cell
# and run it after training has finished. It writes everything the report needs into
#   /content/drive/MyDrive/aeroday/thermal_person/report/
# and downloads it as report.zip.
#
# What it does:
#   1. Test-set metrics of our model (images never used in training or model selection)
#   2. The same test for the original YOLOv8n (trained on normal photos, never on thermal)
#      -> shows what our fine-tuning adds
#   3. Model size and CPU speed (is it light enough for a drone's onboard computer?)
#   4. 5 example detections on real thermal test images
#   5. Everything saved to metrics.json + images, zipped and downloaded

import glob
import json
import os
import random
import shutil
import time

from ultralytics import YOLO

RUN = "/content/drive/MyDrive/aeroday/thermal_person"   # where training saved its results
DATA_DIR = "/content/thermal_yolo"
DATA = f"{DATA_DIR}/dataset.yaml"
OUT = f"{RUN}/report"
os.makedirs(f"{OUT}/examples", exist_ok=True)

# --- 0. If Colab was restarted, the exported dataset is gone: rebuild it (same seed = same split)
if not os.path.exists(DATA):
    import fiftyone as fo
    import fiftyone.utils.huggingface as fouh
    import fiftyone.utils.random as four
    NAME = "Voxel51/Thermal-Person-Detector"
    ds = fo.load_dataset(NAME) if fo.dataset_exists(NAME) else fouh.load_from_hub(NAME)
    ds.untag_samples(["train", "val", "test"])
    four.random_split(ds, {"train": 0.70, "val": 0.15, "test": 0.15}, seed=42)
    for split in ["train", "val", "test"]:
        ds.match_tags(split).export(export_dir=DATA_DIR, dataset_type=fo.types.YOLOv5Dataset,
                                    label_field="ground_truth", split=split, classes=["person"])

model = YOLO(f"{RUN}/weights/best.pt")


def box_metrics(m):
    return {"precision": round(float(m.box.mp), 4),
            "recall": round(float(m.box.mr), 4),
            "mAP50": round(float(m.box.map50), 4),
            "mAP50_95": round(float(m.box.map), 4),
            "speed_ms_per_image_gpu": {k: round(v, 2) for k, v in m.speed.items()}}


# --- 1. Our model on the TEST set (also draws the confusion matrix and the PR / F1 curves)
ours = model.val(data=DATA, split="test", project=RUN, name="test_eval", exist_ok=True, plots=True)
ours_m = box_metrics(ours)
print("OUR MODEL (test):", ours_m)

# --- 2. Baseline: the original YOLOv8n, never trained on thermal images ("person" = COCO class 0)
try:
    base = YOLO("yolov8n.pt").val(data=DATA, split="test", classes=[0], project=RUN,
                                  name="baseline_eval", exist_ok=True, plots=False)
    base_m = box_metrics(base)
except Exception as e:  # never block the report on the baseline
    base_m = {"error": str(e)}
print("BASELINE yolov8n, no thermal training (test):", base_m)

# --- 3. Size and CPU speed
from ultralytics.utils.torch_utils import get_flops
params = sum(p.numel() for p in model.model.parameters())
gflops = get_flops(model.model, 640)
layers = len(list(model.model.modules()))
test_imgs = sorted(glob.glob(f"{DATA_DIR}/images/test/*"))
sample = random.Random(0).sample(test_imgs, 50)
model.predict(sample[0], device="cpu", verbose=False)              # warm-up
t = time.time()
for p in sample:
    model.predict(p, device="cpu", imgsz=640, verbose=False)
cpu_ms = (time.time() - t) / len(sample) * 1000
print(f"Size: {params / 1e6:.2f} M parameters, {gflops:.1f} GFLOPs | CPU: {cpu_ms:.0f} ms/image = {1000 / cpu_ms:.1f} fps")

# --- 4. Five example detections on test images that contain people
with_people = [p for p in test_imgs
               if os.path.getsize(p.replace("/images/", "/labels/").rsplit(".", 1)[0] + ".txt") > 0]
for i, p in enumerate(random.Random(1).sample(with_people, 5), 1):
    r = model.predict(p, conf=0.5, verbose=False)[0]
    r.save(filename=f"{OUT}/examples/example_{i}.jpg")

# --- 5. Save the numbers, copy the plots, zip and download
metrics = {
    "dataset": {"name": "Voxel51/Thermal-Person-Detector (Hugging Face)", "images": 8778,
                "person_boxes": 18695, "split": {"train": 6145, "val": 1316, "test": 1317},
                "split_method": "random 70/15/15, seed 42"},
    "training": {"base_model": "yolov8n.pt (COCO pretrained)", "epochs_max": 40, "patience": 10,
                 "imgsz": 640, "batch": 16, "seed": 42},
    "test_our_model": ours_m,
    "test_baseline_yolov8n_no_thermal_training": base_m,
    "model_size": {"layers": int(layers), "parameters_M": round(params / 1e6, 2),
                   "GFLOPs": round(float(gflops), 1),
                   "weights_MB": round(os.path.getsize(f"{RUN}/weights/best.pt") / 1e6, 1)},
    "cpu_speed": {"ms_per_image": round(cpu_ms, 1), "fps": round(1000 / cpu_ms, 1),
                  "note": "Colab CPU, imgsz 640, 50 test images"},
}
with open(f"{OUT}/metrics.json", "w") as f:
    json.dump(metrics, f, indent=2)

for png in glob.glob(f"{RUN}/test_eval/*.png") + glob.glob(f"{RUN}/*.png"):  # confusion matrix, curves, results.png
    shutil.copy(png, OUT)
shutil.copy(f"{RUN}/results.csv", OUT)            # loss and metrics per epoch
shutil.copy(f"{RUN}/weights/best.pt", OUT)        # the trained model

print(json.dumps(metrics, indent=2))
shutil.make_archive("/content/report", "zip", OUT)
from google.colab import files
files.download("/content/report.zip")
