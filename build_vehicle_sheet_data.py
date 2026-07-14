#!/usr/bin/env python3
"""
build_vehicle_sheet_data.py
---------------------------
Builds sheets/vehicle-data.json — a compact per-variant stats database used to
self-draw Classic BattleTech COMBAT VEHICLE record sheets (ground vehicles and
VTOLs) in the Lance Builder, the vehicle counterpart of build_sheet_data.py.

Source data is the MegaMek unit database (mm-data, CC BY-NC-SA 4.0 fan data —
the same footing as the MTF mech data already used here). Vehicles are stored
as .blk files: simple <Tag>...</Tag> blocks. Get them with:

  git clone --depth 1 --filter=blob:none --sparse \
      https://github.com/MegaMek/mm-data.git
  cd mm-data && git sparse-checkout set data/mekfiles/vehicles

Usage
-----
  py build_vehicle_sheet_data.py --blk-dir path/to/mm-data/data/mekfiles/vehicles

What's included: UnitType Tank/VTOL with motion Tracked/Wheeled/Hover/WiGE/VTOL
and a standard 4- or 5-facing armor array (Front/Right/Left/Rear[/Turret or
Rotor]). Dual-turret (6 facings) and superheavy (7-8 facings) vehicles are
skipped — those need a different sheet layout, and fall back to the PDF path.

Field notes (verified against MegaMek source + canon record sheets):
 - armor array order:   Front, Right, Left, Rear, [Turret | Rotor (VTOL)]
 - engine_type codes:   BLKFile.java (0=Fusion 1=ICE 2=XL ... 6=Fuel Cell ...)
 - engine rating:       cruiseMP*tons - suspensionFactor(motion,tons), rounded
                        up to a multiple of 5 (Tank.java getSuspensionFactor;
                        checked: Vedette 250, Condor 215, Warrior H-7 50)
 - Battle Value is NOT in the .blk data; sheets render BV as "—".
"""

import argparse
import glob
import json
import os
import re
from datetime import datetime, timezone

# Reuse the mech pipeline's MegaMek-code decoder + ammo shots table so the
# two datasets normalize equipment names identically.
from build_sheet_data import mtf_decode, norm, MTF_AMMO_SHOTS

OUTPUT = os.path.join("sheets", "vehicle-data.json")

MOTIONS = {"Tracked", "Wheeled", "Hover", "WiGE", "VTOL"}

# BLKFile.java engine type codes.
ENGINE_NAMES = {
    0: "Fusion", 1: "ICE", 2: "XL Fusion", 3: "XXL Fusion", 4: "Light Fusion",
    5: "Compact Fusion", 6: "Fuel Cell", 7: "Fission", 8: "None",
    9: "MagLev", 10: "Steam", 11: "Battery", 12: "Solar", 13: "External",
}

# EquipmentType.java T_ARMOR_* codes (vehicle-relevant subset).
ARMOR_NAMES = {
    0: "Standard", 1: "Ferro-Fibrous", 2: "Reactive", 3: "Reflective",
    4: "Hardened", 5: "Light Ferro-Fibrous", 6: "Heavy Ferro-Fibrous",
    8: "Stealth", 9: "Ferro-Fibrous (Proto)", 10: "Commercial",
    14: "Industrial", 16: "Ferro-Lamellor", 17: "Primitive",
    22: "Vehicular Stealth", 23: "Anti-Penetrative Ablation",
    24: "Heat-Dissipating", 25: "Impact-Resistant", 26: "Ballistic-Reinforced",
}

# Tank.java getSuspensionFactor(). Tracked is 0.
def suspension_factor(motion, tons):
    t = float(tons)
    if motion == "Hover":
        for cap, sf in ((10, 40), (20, 85), (30, 130), (40, 175), (50, 235)):
            if t <= cap:
                return sf
        return 235 + 45 * -int(-(t - 50) // 25)
    if motion == "VTOL":
        for cap, sf in ((10, 50), (20, 95), (30, 140)):
            if t <= cap:
                return sf
        return 140 + 45 * -int(-(t - 30) // 20)
    if motion == "Wheeled":
        return 20 if t <= 80 else 40
    if motion == "WiGE":
        for cap, sf in ((15, 45), (30, 80), (45, 115), (80, 140)):
            if t <= cap:
                return sf
        return 140 + 35 * -int(-(t - 80) // 30)
    return 0  # Tracked


def engine_rating(motion, tons, cruise):
    raw = cruise * int(tons) - suspension_factor(motion, tons)
    return max(10, -(-raw // 5) * 5)  # round up to a multiple of 5


def tag(txt, name):
    m = re.search(r"<%s>\s*\n(.*?)\n?\s*</%s>" % (re.escape(name), re.escape(name)),
                  txt, re.DOTALL)
    return m.group(1).strip() if m else ""


def tag_lines(txt, name):
    return [ln.strip() for ln in tag(txt, name).splitlines() if ln.strip()]


# ── Equipment name cleanup ──────────────────────────────────────────────────
# .blk equipment strings mix readable names ("Machine Gun", "SRM 6"), MegaMek
# codes ("ISERMediumLaser", "CLLBXAC10") and ammo lines ("IS Ammo SRM-6",
# "ISAMS Ammo", "IS Machine Gun Ammo - Half"). Normalize to the display names
# the app's RS_WEAPON_STATS / RS_AMMO_SHOTS tables are keyed by.

RENAMES = {
    "Flamer (Vehicle)": "Vehicle Flamer",
    "Vehicle Flamer": "Vehicle Flamer",
    "Hitch": "Trailer Hitch",
    "VehicleJumpJet": "Vehicle Jump Jet",
    "ArtemisIV": "Artemis IV FCS",
    "Artemis IV": "Artemis IV FCS",
    "AMS": "Anti-Missile System",
    "MagshotGR": "Magshot Gauss Rifle",
    "Magshot GR": "Magshot Gauss Rifle",
    "Light MG": "Light Machine Gun",
    "Heavy MG": "Heavy Machine Gun",
    "Vehicular Stealth": "Vehicular Stealth Armor",
}


def clean_weapon(raw):
    """Normalize one non-ammo equipment string to a display name, or None."""
    s = raw.strip()
    if not s:
        return None
    s = re.sub(r":(OMNI|SPONSON|PINTLE).*$", "", s, flags=re.I).strip()
    s = re.sub(r"\((ST|Sqd\d+)\)$", "", s).strip()
    if s in RENAMES:
        return RENAMES[s]
    # Strip IS/CL prefixes: "ISGaussRifle" -> decode("GaussRifle"),
    # "ISTargeting Computer" -> "Targeting Computer", "IS Vehicular Stealth".
    m = re.match(r"^(CL|IS)(?=[A-Z0-9]|i[A-Z])", s)
    if m:
        rest = s[m.end():]
        s = rest if " " in rest else mtf_decode(rest)
    else:
        s = re.sub(r"^(IS|Clan)\s+", "", s)
    if s in RENAMES:
        return RENAMES[s]
    if " " not in s and re.search(r"[A-Z].*[A-Z0-9]", s[1:] or ""):
        s = mtf_decode(s)  # camel-case code that had no IS/CL prefix
    # "SRM 6" / "LRM 15" / "Streak SRM 4" -> hyphenated table keys.
    s = re.sub(r"\b(LRM|SRM|MRM|MML|ATM|iATM)[ ](\d+)\b", r"\1-\2", s)
    s = s.replace("Auto Cannon", "AC").replace("Autocannon ", "Autocannon/")
    return RENAMES.get(s, s)


def clean_ammo(raw):
    """Parse an ammo line -> (weapon display name, shots) or None."""
    s = raw.strip()
    half = bool(re.search(r"\bhalf\b", s, re.I))
    s = re.sub(r"\s*-\s*(Full|Half)\s*$", "", s, flags=re.I)
    s = re.sub(r"\s*\(\d+\)\s*$", "", s)  # "(15)" shot-count suffixes
    w = re.sub(r"^(IS|Clan|CL)\s*", "", s, flags=re.I)
    w = re.sub(r"ammo", "", w, flags=re.I).strip(" -")
    w = re.sub(r"\bArtemis-?\s*capable\b", "", w, flags=re.I).strip(" -")
    w = re.sub(r"\b(Cluster|Slug)\b", "", w, flags=re.I).strip(" -")
    if " " not in w and w:
        w = mtf_decode(w)  # camel-case code like "MediumChemLaser"
    w = w.replace("Chem Laser", "Chemical Laser")
    w = re.sub(r"\b(LRM|SRM|MRM|MML|ATM|iATM)[ ](\d+)\b", r"\1-\2", w)
    if w == "Gauss":
        w = "Gauss Rifle"
    if w in ("MG", "Machine Gun"):
        w = "Machine Gun"
    if w == "AMS":
        w = "Anti-Missile System"
    if w.startswith("MML-") and re.search(r"(LRM|SRM)$", w):
        w = re.sub(r"\s*(LRM|SRM)$", "", w)
    if w in ("Vehicle Flamer", "Flamer"):
        w = "Vehicle Flamer"
    shots = MTF_AMMO_SHOTS.get(w)
    if shots and half:
        shots //= 2
    return (w, shots)


LOC_CODES = [
    ("Body Equipment", "BD"), ("Front Equipment", "FR"),
    ("Right Equipment", "RS"), ("Left Equipment", "LS"),
    ("Rear Equipment", "RR"), ("Turret Equipment", "TU"),
    ("Rotor Equipment", "RO"),
]


def parse_blk(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        txt = f.read()

    unit_type = tag(txt, "UnitType")
    if unit_type not in ("Tank", "VTOL"):
        return None
    motion = tag(txt, "motion_type")
    if motion not in MOTIONS:
        return None
    armor_vals = []
    for ln in tag_lines(txt, "armor"):
        try:
            armor_vals.append(int(ln))
        except ValueError:
            return None
    if len(armor_vals) not in (4, 5):
        return None  # dual-turret / superheavy: PDF fallback

    name = tag(txt, "Name")
    model = tag(txt, "Model")
    if not name:
        return None
    full_name = ("%s %s" % (name, model)).strip()
    try:
        tons = int(float(tag(txt, "tonnage") or 0))
    except ValueError:
        return None
    if not tons:
        return None
    try:
        cruise = int(tag(txt, "cruiseMP") or 0)
    except ValueError:
        cruise = 0
    flank = -(-(cruise * 3) // 2)  # ceil(cruise * 1.5)

    try:
        eng_code = int(tag(txt, "engine_type") or 0)
    except ValueError:
        eng_code = 0
    eng_name = ENGINE_NAMES.get(eng_code, "Fusion")
    engine = "%d %s" % (engine_rating(motion, tons, cruise), eng_name)

    try:
        armor_code = int(tag(txt, "armor_type") or 0)
    except ValueError:
        armor_code = 0

    # "<type>": "IS Level 1", "Clan Level 3", "Mixed (IS Chassis) Advanced"...
    # — the rules level appears either as "Level N" or as a plain word.
    type_str = tag(txt, "type")
    tech = ("Clan" if type_str.startswith("Clan")
            else "Mixed" if type_str.startswith("Mixed") else "Inner Sphere")
    lvl = re.search(r"Level (\d)", type_str)
    rules = {1: "Introductory", 2: "Standard", 3: "Advanced",
             4: "Experimental", 5: "Unofficial"}.get(int(lvl.group(1)) if lvl else 0, "")
    if not rules:
        word = re.search(r"(Introductory|Standard|Advanced|Experimental|Unofficial)\s*$",
                         type_str)
        rules = word.group(1) if word else ""

    armor = {"front": armor_vals[0], "right": armor_vals[1],
             "left": armor_vals[2], "rear": armor_vals[3]}
    if len(armor_vals) == 5:
        armor["rotor" if unit_type == "VTOL" else "turret"] = armor_vals[4]

    # Equipment: group identical (name, loc) into qty; ammo aggregates apart.
    weapons = {}   # (name, loc) -> qty, insertion-ordered
    ammo = {}      # weapon name -> total shots (or None if unknown)
    jump = 0
    for tag_name, loc in LOC_CODES:
        for ln in tag_lines(txt, tag_name):
            if re.search(r"ammo", ln, re.I):
                w, shots = clean_ammo(ln)
                if not w:
                    continue
                if w in ammo:
                    if ammo[w] is not None and shots is not None:
                        ammo[w] += shots
                else:
                    ammo[w] = shots
                continue
            nm = clean_weapon(ln)
            if not nm:
                continue
            if nm == "Vehicle Jump Jet":
                jump += 1
                continue
            key = (nm, loc)
            weapons[key] = weapons.get(key, 0) + 1

    equipment = [{"qty": q, "name": nm, "loc": loc}
                 for (nm, loc), q in weapons.items()]
    ammo_str = ", ".join(("(%s) %d" % (w, s)) if s else ("(%s)" % w)
                         for w, s in ammo.items())

    try:
        mul_id = int(tag(txt, "mul id:") or 0)
    except ValueError:
        mul_id = 0

    return {
        "name": full_name,
        "chassis": name,
        "model": model,
        "mul": mul_id,
        "tons": tons,
        "unitType": unit_type,
        "motion": motion,
        "techBase": tech,
        "rules": rules,
        "role": tag(txt, "role"),
        "year": tag(txt, "year"),
        "cruise": cruise,
        "flank": flank,
        "jump": jump,
        "engine": engine,
        "armor": armor,
        "armorType": ARMOR_NAMES.get(armor_code, "Standard"),
        "equipment": equipment,
        "ammo": ("Ammo: " + ammo_str) if ammo_str else "",
        "bv": "",
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--blk-dir", required=True,
                    help="mm-data data/mekfiles/vehicles directory")
    args = ap.parse_args()

    files = sorted(glob.glob(os.path.join(args.blk_dir, "**", "*.blk"),
                             recursive=True))
    print("Parsing %d .blk files from %s ..." % (len(files), args.blk_dir))

    # Vehicle variants routinely differ only by a parenthetical the app's
    # sbNorm() strips ("Condor Heavy Hover Tank (Ultra)"), so records get a
    # UNIQUE key (norm name, suffixed by MUL id on collision). byMul gives
    # exact variant matching (every MUL search unit has an Id); byName maps
    # each normalized name to its base variant (shortest raw name) as the
    # fallback when a unit has no MUL id.
    vehicles = {}
    by_mul = {}
    by_name = {}
    best_name = {}  # norm name -> raw name currently holding the alias
    skipped = 0
    for path in files:
        try:
            rec = parse_blk(path)
        except Exception as e:
            print("  ! %s: %s" % (os.path.basename(path), e))
            skipped += 1
            continue
        if not rec:
            skipped += 1
            continue
        n = norm(rec["name"])
        key = n if n not in vehicles else "%s|%s" % (n, rec["mul"] or len(vehicles))
        vehicles[key] = rec
        if rec["mul"]:
            by_mul[str(rec["mul"])] = key
        if n not in by_name or len(rec["name"]) < len(best_name[n]):
            by_name[n] = key
            best_name[n] = rec["name"]

    os.makedirs("sheets", exist_ok=True)
    out = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "count": len(vehicles),
        "vehicles": vehicles,
        "byMul": by_mul,
        "byName": by_name,
    }
    with open(OUTPUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print("Wrote %s  (%d vehicles, %d MUL ids, %d skipped)"
          % (OUTPUT, len(vehicles), len(by_mul), skipped))


if __name__ == "__main__":
    main()
