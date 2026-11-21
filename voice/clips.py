"""The Tunisian (Derja) voice clips: file name -> what to say when recording it.

Recorded with:  python voice/record_clips.py
Stored in:      voice/clips/<name>.wav

The text here is only a guide for whoever records; say it the most natural way.
If you change a sentence while recording, update the text here too (it documents the clip).
"""
from pathlib import Path

CLIP_DIR = Path(__file__).parent / "clips"

CLIPS = {
    # --- the message to a victim, played in this order ---
    "hello":      "Ahla, ena drone mta3 el Protection Civile. Ma t5afech, rana jeyin n3awnouk.",
    "smoke":      "Hbat 9rib mel 9a3a, w ghatti fommek w nifek b 7wayjek.",
    "exit_intro": "A7sen sortie lik, w aslem wa7da, hiya...",   # the SAFEST exit (sim picks safest, not nearest)
    "exit_E1":    "...sortie numéro wa7ed.",
    "exit_E2":    "...sortie numéro zouz.",
    "exit_E3":    "...sortie numéro thletha.",
    "coming":     "El pompiers fi thniya, jeyin taw.",
    "ask_walk":   "Tnajjem temchi wa7dek? Jawebni b 'ey' walla 'le'.",
    # --- played after the answer, depending on the status ---
    "after_walking":   "Behi. Emchi bchwaya, hbat, w tab3 el sortie.",
    "after_injured":   "Ma tet7arrekch. El pompiers jeyin lik bidhat. Rak mouch wa7dek.",
    "after_no_answer": "Ken tesma3ni, a3mel 7es, odhrob 3al 7it. El pompiers jeyin.",
}

# French versions of the closing sentences (spoken by the French voice).
AFTER_FR = {
    "walking":   "Très bien. Marchez lentement, restez bas, et suivez la sortie.",
    "injured":   "Ne bougez pas. Les pompiers arrivent pour vous. Vous n'êtes pas seul.",
    "no_answer": "Si vous m'entendez, faites du bruit, frappez sur le mur. Les secours arrivent.",
}


def path(name):
    return CLIP_DIR / f"{name}.wav"


def missing():
    return [n for n in CLIPS if not path(n).exists()]
