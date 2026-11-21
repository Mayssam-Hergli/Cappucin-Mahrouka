# vision/: the drone's camera

`fake_thermal.py` uses the laptop webcam to stand in for the drone's thermal camera.

Pipeline: webcam → YOLOv8n person detection → greyscale image with the person bright and the background dark → `COLORMAP_INFERNO` → box and "PERSON DETECTED".

When a person is detected (`conf ≥ 0.5`), it sends a frame about every 0.5 s:

```
POST /api/vision  {"person": true, "conf": 0.87, "jpg": "<base64 320x240 JPEG>"}
```

## Run

```bash
python vision/fake_thermal.py --server http://SERVER_IP:5000
```
