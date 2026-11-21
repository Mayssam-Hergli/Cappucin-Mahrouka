"""Génère la carte de démo (provisoire) au format de sim/factory.json.

Teammate 2 possède sim/factory.json ; tant qu'il n'existe pas, le serveur
utilise server/data/factory_demo.json créé par ce script.
  python server/data/make_factory.py
"""
import json
import os

W, H = 40, 25
g = [["." for _ in range(W)] for _ in range(H)]


def put(x, y, c):
    g[y][x] = c


def rect(x0, y0, x1, y1, c):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            put(x, y, c)


# Murs extérieurs
for x in range(W):
    put(x, 0, "#"); put(x, H - 1, "#")
for y in range(H):
    put(0, y, "#"); put(W - 1, y, "#")
# Murs intérieurs
for y in range(H):
    put(12, y, "#")                      # bureaux/solvants | atelier/stocks
for x in range(0, 13):
    put(x, 9, "#")                       # bureaux | solvants
for x in range(12, W):
    put(x, 14, "#")                      # atelier | stocks
for y in range(14, H):
    put(26, y, "#")                      # papier | local technique

# Portes intérieures
for (x, y) in [(12, 4), (6, 9), (12, 18), (19, 14), (33, 14), (26, 19)]:
    put(x, y, "D")
# Sorties
for (x, y) in [(0, 4), (19, 24), (39, 7)]:
    put(x, y, "E")

# Stock solvants (classe B)
rect(2, 11, 9, 11, "F"); rect(2, 14, 9, 14, "F"); rect(2, 17, 9, 17, "F"); rect(2, 20, 9, 21, "F")
# Stock papier / bois (classe A)
rect(14, 16, 24, 16, "P"); rect(14, 19, 17, 20, "P"); rect(21, 19, 24, 20, "P"); rect(14, 22, 24, 22, "P")
# Local technique : bouteilles de gaz (C) + armoires électriques
rect(34, 16, 37, 17, "G"); rect(28, 16, 30, 16, "X"); rect(28, 21, 29, 22, "X")
# Atelier : quelques cartons et une armoire
rect(35, 2, 37, 3, "P"); put(14, 2, "X")

data = {
    "name": "Usine démo — Textiles & Solvants (fictive)",
    "cell_m": 1,
    "grid": ["".join(r) for r in g],
    "zones": [
        {"id": "Z1", "name": "Bureaux", "rect": [1, 1, 11, 8]},
        {"id": "Z2", "name": "Atelier de production", "rect": [13, 1, 38, 13]},
        {"id": "Z3", "name": "Stock solvants", "rect": [1, 10, 11, 23]},
        {"id": "Z4", "name": "Stock papier / bois", "rect": [13, 15, 25, 23]},
        {"id": "Z5", "name": "Local technique (gaz, électricité)", "rect": [27, 15, 38, 23]},
    ],
    "sensors": [
        {"id": "N1", "zone": "Z3", "x": 6, "y": 15},
        {"id": "N2", "zone": "Z2", "x": 25, "y": 7},
        {"id": "N3", "zone": "Z4", "x": 19, "y": 18},
        {"id": "N4", "zone": "Z5", "x": 32, "y": 19},
    ],
    "victims": [
        {"id": "V1", "x": 4, "y": 6},
        {"id": "V2", "x": 9, "y": 19},
        {"id": "V3", "x": 30, "y": 10},
        {"id": "V4", "x": 22, "y": 21},
        {"id": "V5", "x": 36, "y": 20},
    ],
    "exits": [
        {"id": "E1", "x": 0, "y": 4, "name": "Sortie Ouest (bureaux)"},
        {"id": "E2", "x": 19, "y": 24, "name": "Sortie Sud (quai papier)"},
        {"id": "E3", "x": 39, "y": 7, "name": "Sortie Est (atelier)"},
    ],
    "hydrants": [[1, 2], [38, 12], [20, 23]],
    # Ajout dashboard (n'affecte pas le contrat Sim) : équipements à afficher
    "equipment": [
        {"type": "metal", "x": 17, "y": 5, "label": "Presse hydraulique"},
        {"type": "metal", "x": 22, "y": 5, "label": "Métier à tisser"},
        {"type": "metal", "x": 27, "y": 5, "label": "Métier à tisser"},
        {"type": "metal", "x": 22, "y": 10, "label": "Convoyeur"},
        {"type": "metal", "x": 30, "y": 3, "label": "Compresseur"},
        {"type": "electric", "x": 14, "y": 2, "label": "Armoire électrique atelier"},
        {"type": "electric", "x": 28, "y": 16, "label": "TGBT (tableau général)"},
        {"type": "electric", "x": 28, "y": 21, "label": "Transformateur"},
        {"type": "gas", "x": 35, "y": 16, "label": "Bouteilles propane"},
        {"type": "valve", "x": 33, "y": 18, "label": "Vanne de coupure gaz"},
        {"type": "solvent", "x": 5, "y": 11, "label": "Fûts d'acétone"},
        {"type": "solvent", "x": 5, "y": 20, "label": "Cuves de solvant"},
        {"type": "extinguisher", "x": 11, "y": 12, "label": "Extincteur CO₂"},
        {"type": "extinguisher", "x": 13, "y": 13, "label": "Extincteur poudre"},
        {"type": "extinguisher", "x": 25, "y": 15, "label": "Extincteur eau"},
        {"type": "extinguisher", "x": 31, "y": 22, "label": "Extincteur CO₂"},
        {"type": "extinguisher", "x": 2, "y": 2, "label": "Extincteur eau"},
    ],
}

out = os.path.join(os.path.dirname(__file__), "factory_demo.json")
with open(out, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=1)
print("\n".join(data["grid"]))
print("->", out)
