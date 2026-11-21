"""The drone's camera, simulated with the laptop webcam.

webcam -> YOLOv8n finds people -> person bright, background dark
-> COLORMAP_INFERNO -> box + "PERSON DETECTED" -> (optional) POST /api/vision

This is only for the live demo. The real thermal detector is trained and tested
on real thermal images (see ai/).

Usage:
    python vision/fake_thermal.py                                 # local test, sends nothing
    python vision/fake_thermal.py --server http://SERVER_IP:5000  # also sends to the server
Options: --box (box-only look), --camera 1 (other webcam).  Keys: q or Esc = quit.
"""
import argparse
import base64
import threading
import time

import cv2
import numpy as np
import requests
from ultralytics import YOLO

PERSON = 0         # "person" class id in the pretrained (COCO) model
MIN_CONF = 0.5     # report a person only above this confidence
POST_PERIOD = 0.5  # seconds between two POSTs


def thermal_look(frame, person_mask):
    """Dark grey background, glowing person, then the INFERNO thermal palette."""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(np.float32)
    gray = cv2.GaussianBlur(gray, (0, 0), 3)                  # thermal images are blurry
    background = 25 + 0.30 * gray                              # cool, keeps a little detail
    body = 170 + 0.35 * gray                                   # hot, keeps a little texture
    m = cv2.GaussianBlur(person_mask, (0, 0), 9)               # soft heat halo around the body
    img = background * (1 - m) + body * m
    img += np.random.normal(0, 3, img.shape)                   # sensor noise
    img = np.clip(img, 0, 255).astype(np.uint8)
    return cv2.applyColorMap(img, cv2.COLORMAP_INFERNO)


class Sender:
    """Sends frames to the server in a background thread, so the video never freezes."""

    def __init__(self, server):
        self.url = server.rstrip("/") + "/api/vision"
        self.status = "waiting"
        self.busy = False

    def send(self, conf, image):
        if self.busy:  # previous POST still running: skip this frame
            return
        self.busy = True
        threading.Thread(target=self._post, args=(conf, image), daemon=True).start()

    def _post(self, conf, image):
        try:
            small = cv2.resize(image, (320, 240))
            _, jpg = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 70])
            body = {"person": True,
                    "conf": round(float(conf), 2),
                    "jpg": base64.b64encode(jpg.tobytes()).decode("ascii")}
            r = requests.post(self.url, json=body, timeout=2)
            self.status = f"sent ({r.status_code})"
        except requests.RequestException as e:
            self.status = f"server unreachable ({type(e).__name__})"
        finally:
            self.busy = False


def main():
    p = argparse.ArgumentParser(description="Fake thermal camera (webcam + YOLOv8n)")
    p.add_argument("--server", help="Flask hub URL, e.g. http://192.168.43.10:5000 (omit = send nothing)")
    p.add_argument("--camera", type=int, default=0, help="webcam index")
    p.add_argument("--box", action="store_true", help="box-only look instead of the body silhouette")
    args = p.parse_args()

    # Both models are downloaded automatically the first time (a few MB).
    model = YOLO("yolov8n.pt" if args.box else "yolov8n-seg.pt")

    cam = cv2.VideoCapture(args.camera, cv2.CAP_DSHOW)  # CAP_DSHOW: opens faster on Windows
    if not cam.isOpened():
        cam = cv2.VideoCapture(args.camera)
    if not cam.isOpened():
        raise SystemExit(f"Cannot open webcam {args.camera}. Try --camera 1.")

    sender = Sender(args.server) if args.server else None
    last_post = 0.0
    fps, t_prev = 0.0, time.time()

    while True:
        ok, frame = cam.read()
        if not ok:
            time.sleep(0.1)
            continue
        frame = cv2.flip(frame, 1)  # mirror image: easier to demo
        h, w = frame.shape[:2]

        result = model(frame, classes=[PERSON], conf=0.25, verbose=False)[0]

        # Where are the people? Build a 0..1 mask of "hot" pixels.
        mask = np.zeros((h, w), np.float32)
        people = []
        for i, box in enumerate(result.boxes):
            conf = float(box.conf[0])
            x1, y1, x2, y2 = map(int, box.xyxy[0])
            people.append((conf, x1, y1, x2, y2))
            if result.masks is not None:  # silhouette model: the real body outline
                body = cv2.resize(result.masks.data[i].cpu().numpy(), (w, h))
                mask = np.maximum(mask, body)
            else:                         # box model: a glowing oval inside the box
                cv2.ellipse(mask, ((x1 + x2) // 2, (y1 + y2) // 2),
                            ((x2 - x1) // 2, (y2 - y1) // 2), 0, 0, 360, 1.0, -1)

        out = thermal_look(frame, mask)

        # Boxes: green = confident person, grey = unsure.
        for conf, x1, y1, x2, y2 in people:
            color = (0, 255, 0) if conf >= MIN_CONF else (160, 160, 160)
            cv2.rectangle(out, (x1, y1), (x2, y2), color, 2)
            cv2.putText(out, f"person {conf:.2f}", (x1, max(20, y1 - 8)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)

        best = max((p[0] for p in people), default=0.0)
        if best >= MIN_CONF:
            cv2.putText(out, "PERSON DETECTED", (20, 45),
                        cv2.FONT_HERSHEY_DUPLEX, 1.2, (0, 255, 0), 3)
            if sender and time.time() - last_post >= POST_PERIOD:
                sender.send(best, out)
                last_post = time.time()

        # Status line at the bottom.
        now = time.time()
        fps = 0.9 * fps + 0.1 / max(now - t_prev, 1e-6)
        t_prev = now
        status = sender.status if sender else "local test (no --server)"
        cv2.putText(out, f"THERMAL SIM  {fps:4.1f} fps  |  {status}", (10, h - 12),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)

        cv2.imshow("Drone thermal camera (simulated)", out)
        if cv2.waitKey(1) & 0xFF in (ord("q"), 27):
            break

    cam.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
