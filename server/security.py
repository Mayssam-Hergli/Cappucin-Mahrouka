"""Sécurité du hub : messages capteurs signés (HMAC-SHA256), validation des entrées.

Signature d'un message capteur (POST /api/sensor) :
    le corps JSON ne change pas ; le nœud ajoute trois en-têtes
        X-Hrika-Time : heure Unix du nœud (secondes, entier)
        X-Hrika-Seq  : compteur de messages depuis le démarrage du nœud
        X-Hrika-Sig  : hex( HMAC-SHA256( clé du nœud, "<time>.<seq>.<corps brut>" ) )
    Le serveur refuse : signature fausse, message vieux de plus de 30 s,
    et rejeu (couple (time, seq) pas plus récent que le dernier accepté).
    Chaque réponse contient "t" = heure du serveur : le nœud y cale son horloge (pas besoin de NTP).

Clés : server/keys/nodes.json (jamais commité, voir .gitignore), {"N1": "<64 hex>", ...}.
    Fichier absent  -> messages non signés acceptés (mode développement, un avertissement au démarrage).
    Fichier présent -> tout capteur doit signer avec sa clé.
    SENSOR_AUTH=off -> désactive la vérification (secours le jour J).

    python server/security.py new-key N1     # crée/remplace la clé de N1 et affiche le secrets.h du nœud
"""
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
KEYS_FILE = os.environ.get("HRIKA_KEYS_FILE", os.path.join(HERE, "keys", "nodes.json"))
MAX_SKEW_S = 30

LEVELS = {"NORMAL", "WARNING", "ALARM"}
CAUSES = {"gas", "temp", "flame", "none", ""}
VICTIM_STATUSES = {"walking", "injured", "no_answer"}
B64 = re.compile(r"[A-Za-z0-9+/]+={0,2}")


def load_keys():
    try:
        with open(KEYS_FILE, encoding="utf-8") as f:
            return {k: bytes.fromhex(v) for k, v in json.load(f).items()}
    except FileNotFoundError:
        return None


class SensorAuth:
    def __init__(self):
        self.keys = load_keys()
        self.enabled = self.keys is not None and os.environ.get("SENSOR_AUTH", "on") != "off"
        self.last = {}                       # node -> (time, seq) du dernier message accepté
        if self.enabled:
            print(f"[sécurité] messages capteurs signés exigés ({', '.join(sorted(self.keys))})")
        else:
            print("[sécurité] ATTENTION : messages capteurs NON signés acceptés "
                  f"(pas de {os.path.relpath(KEYS_FILE)} ou SENSOR_AUTH=off)")

    def check(self, node, headers, raw):
        """Renvoie None si le message est accepté, sinon la raison du refus (texte court)."""
        if not self.enabled:
            return None
        key = self.keys.get(node)
        if key is None:
            return "capteur sans clé"
        try:
            ts, seq = int(headers.get("X-Hrika-Time", "")), int(headers.get("X-Hrika-Seq", ""))
        except ValueError:
            return "message non signé"
        sig = headers.get("X-Hrika-Sig", "")
        good = hmac.new(key, f"{ts}.{seq}.".encode() + raw, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(good, sig.lower()):
            return "signature invalide"
        if abs(time.time() - ts) > MAX_SKEW_S:
            return "message périmé"
        if (ts, seq) <= self.last.get(node, (0, -1)):
            return "message rejoué"
        self.last[node] = (ts, seq)
        return None


# ------------------------------------------------------------------ validation

def num(v, lo, hi):
    """Nombre dans [lo, hi], sinon ValueError."""
    if isinstance(v, bool):
        raise ValueError
    f = float(v)
    if not lo <= f <= hi:
        raise ValueError
    return f


def clean_sensor(d, factory):
    """Message capteur -> dict propre, ou ValueError. La zone vient toujours de factory.json."""
    node = d.get("node")
    known = {s["id"]: s for s in factory.get("sensors", [])}
    if node not in known:
        raise ValueError("capteur inconnu")
    level = d.get("level", "NORMAL")
    cause = d.get("cause", "none")
    if level not in LEVELS or cause not in CAUSES:
        raise ValueError("niveau ou cause inconnus")
    # limites larges : elles écartent les valeurs absurdes, jamais une vraie alarme
    # (gasForServer du firmware peut monter vers 17 000 quand le MQ-2 sature)
    try:
        gas = int(num(d.get("gas", 0), 0, 100_000))
        temp = round(num(d.get("temp", 0), -60, 200), 1)
    except (ValueError, TypeError):
        raise ValueError("gaz ou température hors limites") from None
    return {"node": node, "zone": known[node]["zone"], "gas": gas, "temp": temp,
            "flame": 1 if d.get("flame") in (1, True, "1") else 0,
            "level": level, "cause": cause}


def clean_jpg(v):
    if v is None:
        return None
    if not isinstance(v, str) or len(v) > 1_500_000 or not B64.fullmatch(v):
        raise ValueError("image invalide")
    return v


# ----------------------------------------------------------------------- outil

def new_key(node):
    keys = {}
    if os.path.exists(KEYS_FILE):
        with open(KEYS_FILE, encoding="utf-8") as f:
            keys = json.load(f)
    keys[node] = secrets.token_hex(32)
    os.makedirs(os.path.dirname(KEYS_FILE), exist_ok=True)
    with open(KEYS_FILE, "w", encoding="utf-8") as f:
        json.dump(keys, f, indent=2)
    print(f"Clé de {node} enregistrée dans {KEYS_FILE}\n")
    print("À copier dans iot/hrika_node/secrets.h (fichier ignoré par git) :\n")
    print(f'#define NODE_KEY_HEX "{keys[node]}"')


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "new-key":
        new_key(sys.argv[2])
    else:
        print(__doc__)
