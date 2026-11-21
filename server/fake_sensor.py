"""Faux nœud ESP32 : envoie /api/sensor toutes les secondes (pour tester sans matériel).

    python server/fake_sensor.py                    # serveur local, nœud N1 zone Z3
    python server/fake_sensor.py --server http://192.168.43.10:5000 --node N1 --zone Z3

Appuyer sur Entrée pour simuler une fuite de gaz / départ de feu (montée progressive
NORMAL -> WARNING -> ALARM). Appuyer encore pour revenir à la normale.
Aucune dépendance (urllib seulement).
"""
import argparse
import json
import random
import threading
import time
import urllib.request

p = argparse.ArgumentParser()
p.add_argument("--server", default="http://127.0.0.1:5000")
p.add_argument("--node", default="N1")
p.add_argument("--zone", default="Z3")
args = p.parse_args()

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
    try:
        req = urllib.request.Request(args.server + "/api/sensor", data=json.dumps(data).encode(),
                                     headers={"Content-Type": "application/json"})
        r = json.loads(urllib.request.urlopen(req, timeout=2).read())
        print(f"{data['level']:8} gaz={data['gas']:5} temp={data['temp']:5}  -> phase {r.get('phase')}")
    except Exception as e:
        print("serveur injoignable :", e)
    time.sleep(1)
