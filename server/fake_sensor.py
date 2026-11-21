"""Faux nœud ESP32 : envoie /api/sensor toutes les secondes (pour tester sans matériel).

    python server/fake_sensor.py                    # serveur local, nœud N1 zone Z3
    python server/fake_sensor.py --server http://192.168.43.10:5000 --node N1 --zone Z3

Appuyer sur Entrée pour simuler une fuite de gaz / départ de feu (montée progressive
NORMAL -> WARNING -> ALARM). Appuyer encore pour revenir à la normale.
Aucune dépendance (urllib seulement).

Signature : si server/keys/nodes.json contient la clé du nœud, chaque message est signé
(voir server/security.py). --unsigned joue l'attaquant qui n'a pas la clé : le serveur refuse.
"""
import argparse
import hashlib
import hmac
import json
import os
import random
import threading
import time
import urllib.error
import urllib.request

p = argparse.ArgumentParser()
p.add_argument("--server", default="http://127.0.0.1:5000")
p.add_argument("--node", default="N1")
p.add_argument("--zone", default="Z2", help="ignorée par le serveur : la zone vient de factory.json")
p.add_argument("--keys", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "keys", "nodes.json"))
p.add_argument("--unsigned", action="store_true", help="envoyer sans signature (démo d'attaque)")
args = p.parse_args()

key = None
if not args.unsigned and os.path.exists(args.keys):
    with open(args.keys, encoding="utf-8") as f:
        k = json.load(f).get(args.node)
    key = bytes.fromhex(k) if k else None
print("Messages signés (HMAC-SHA256)" if key else "Messages NON signés")
offset, seq = 0.0, 0

fire = False


def keyboard():
    global fire
    while True:
        input()
        fire = not fire
        print(">>> FEU SIMULÉ" if fire else ">>> retour à la normale")


threading.Thread(target=keyboard, daemon=True).start()
print(f"Envoi vers {args.server}/api/sensor (Entrée = déclencher / arrêter)")

gas, temp = 320.0, 24.0
while True:
    if fire:
        gas = min(2600, gas + random.uniform(80, 160))
        temp = min(70, temp + random.uniform(0.6, 1.4))
    else:
        gas = max(300, gas - 120) + random.uniform(-10, 10)
        temp = max(24, temp - 0.8) + random.uniform(-0.1, 0.1)
    if gas > 1500 or temp > 57:
        level, cause = "ALARM", "gas" if gas > 1500 else "temp"
    elif gas > 900 or temp > 40:
        level, cause = "WARNING", "gas" if gas > 900 else "temp"
    else:
        level, cause = "NORMAL", ""
    data = {"node": args.node, "zone": args.zone, "gas": round(gas), "temp": round(temp, 1),
            "flame": 1 if fire and temp > 50 else 0, "level": level, "cause": cause}
    raw = json.dumps(data).encode()
    headers = {"Content-Type": "application/json"}
    if key:
        ts = int(time.time() + offset)
        seq += 1
        headers.update({"X-Hrika-Time": str(ts), "X-Hrika-Seq": str(seq),
                        "X-Hrika-Sig": hmac.new(key, f"{ts}.{seq}.".encode() + raw, hashlib.sha256).hexdigest()})
    try:
        req = urllib.request.Request(args.server + "/api/sensor", data=raw, headers=headers)
        try:
            r = json.loads(urllib.request.urlopen(req, timeout=2).read())
        except urllib.error.HTTPError as e:      # refus du serveur : 400 / 401
            r = json.loads(e.read() or b"{}")
        if "t" in r:
            offset = r["t"] - time.time()        # se caler sur l'horloge du serveur
        status = f"phase {r.get('phase')}" if r.get("ok") else f"REFUSÉ : {r.get('error')}"
        print(f"{data['level']:8} gaz={data['gas']:5} temp={data['temp']:5}  -> {status}")
    except Exception as e:
        print("serveur injoignable :", e)
    time.sleep(1)
