"""TEST ONLY: a tiny fake of server/app.py to test vision/ and voice/ without the real server.

It implements only our 2 routes, exactly as in the shared contract:
    POST /api/vision      GET /api/voice/next

    python voice/mock_server.py
    python vision/fake_thermal.py --server http://127.0.0.1:5000
    python voice/voice.py --server http://127.0.0.1:5000

Open http://127.0.0.1:5000/ to see the last camera frame.
"""
from flask import Flask, jsonify, request

app = Flask(__name__)

# Two fake victims to talk to, like the real server will queue when the drone finds someone.
messages = [
    {"victim": "V1", "say": "Bonjour, je suis le drone de la Protection Civile. Restez calme. "
                            "La sortie la plus sûre est la sortie E1. Restez près du sol. "
                            "La Protection Civile arrive."},
    {"victim": "V2", "say": "Bonjour, je suis le drone de la Protection Civile. Restez calme. "
                            "La sortie la plus sûre est la sortie E3. Restez près du sol. "
                            "La Protection Civile arrive."},
]
seen = {"frame": None, "frames": 0}


@app.post("/api/vision")
def vision():
    d = request.get_json(force=True)
    ok = d.get("person") is True and isinstance(d.get("conf"), (int, float)) and bool(d.get("jpg"))
    seen["frame"], seen["frames"] = d, seen["frames"] + 1
    print(f"[vision] frame #{seen['frames']} conf={d.get('conf')} contract_ok={ok}")
    return jsonify(ok=ok), (200 if ok else 400)


@app.get("/api/voice/next")
def voice_next():
    return jsonify(messages.pop(0) if messages else {})


@app.get("/")
def page():
    f = seen["frame"]
    img = (f'<img src="data:image/jpeg;base64,{f["jpg"]}"><p>conf {f["conf"]}</p>' if f
           else "<p>no camera frame yet</p>")
    return (f'<meta http-equiv="refresh" content="1"><h3>Mock server</h3>'
            f'<p>{seen["frames"]} camera frames received</p>{img}')


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
