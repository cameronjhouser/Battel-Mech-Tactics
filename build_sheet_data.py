#!/usr/bin/env python3
"""
build_sheet_data.py
-------------------
Builds sheets/mech-data.json — a compact per-variant stats database used to
self-draw Classic BattleTech record sheets in the Lance Builder, as an
alternative to embedding the scanned mordel.net PDFs (download_sheets.py).

Source data is the Solaris Skunk Werks (SSW) mech database as vendored by the
jdgwf/battletech-tools project (one XML document per variant). That data is
Catalyst-owned fan-community content, informally shared — the same footing on
which download_sheets.py already re-hosts scanned Catalyst record sheets.

Per-location ARMOR comes straight from the SSW XML. Internal STRUCTURE is NOT
in the XML (it's fully determined by tonnage), so it's computed from the
standard TechManual Internal Structure Table below.

Usage
-----
  py build_sheet_data.py                 # fetch from GitHub, write mech-data.json
  py build_sheet_data.py --src local.ts  # parse a local snapshot instead

Requirements:  py -m pip install requests   (only needed for the network fetch)
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from xml.etree import ElementTree

SSW_URL = ("https://raw.githubusercontent.com/jdgwf/battletech-tools/"
           "master/src/data/ssw/sswMechs.ts")
OUTPUT = os.path.join("sheets", "mech-data.json")

# ---------------------------------------------------------------------------
# Standard Internal Structure Table (TechManual p.47). Head is always 3.
# Columns: (Center Torso, Side Torso, Arm, Leg). Keyed by tonnage.
# Spot-check: 70t -> CT 22, ST 15, Arm 11, Leg 15 (matches the Archer ARC-2K).
# ---------------------------------------------------------------------------
IS_TABLE = {
    20: (6, 5, 3, 4),    25: (8, 6, 4, 6),    30: (10, 7, 5, 7),
    35: (11, 8, 6, 8),   40: (12, 10, 6, 10), 45: (14, 11, 7, 11),
    50: (16, 12, 8, 12), 55: (18, 13, 9, 13), 60: (20, 14, 10, 14),
    65: (21, 15, 10, 15), 70: (22, 15, 11, 15), 75: (23, 16, 12, 16),
    80: (25, 17, 13, 17), 85: (27, 18, 14, 18), 90: (29, 19, 15, 19),
    95: (30, 20, 16, 20), 100: (31, 21, 17, 21),
}


def norm(name):
    """Mirror index.html sbNorm() so lookups line up with MUL unit names."""
    s = (name or "").lower()
    s = re.sub(r"\s*\([^)]*\)", "", s)
    s = re.sub(r"[^a-z0-9 ]", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def structure_for(tons):
    """Per-location internal structure for a standard 'Mech of the given tons."""
    row = IS_TABLE.get(int(tons))
    if not row:
        return None
    ct, st, arm, leg = row
    return {"hd": 3, "ct": ct, "lt": st, "rt": st,
            "la": arm, "ra": arm, "ll": leg, "rl": leg}


def text_of(el, tag, default=""):
    child = el.find(tag)
    return child.text.strip() if child is not None and child.text else default


def extract_xml_docs(ts_source):
    """Pull the backtick-delimited XML strings out of the sswMechs TS array."""
    # Each entry is a template literal: `<?xml ...>...</mech>`
    return re.findall(r"`(\s*<\?xml.*?</mech>\s*)`", ts_source, re.DOTALL)


def parse_mech(xml_str):
    try:
        root = ElementTree.fromstring(xml_str)
    except ElementTree.ParseError:
        return None
    if root.tag != "mech":
        return None

    name = root.get("name", "").strip()
    model = root.get("model", "").strip()
    try:
        tons = int(root.get("tons", "0"))
    except ValueError:
        tons = 0
    if not name or not tons:
        return None

    full_name = ("%s %s" % (name, model)).strip()
    motive = text_of(root, "motive_type", "Biped")

    # --- Armor (per location, straight from the XML) ---
    armor_el = root.find("armor")
    armor = {}
    if armor_el is not None:
        for loc in ("hd", "ct", "ctr", "lt", "ltr", "rt", "rtr",
                    "la", "ra", "ll", "rl", "fll", "frl", "rll", "rrl"):
            v = text_of(armor_el, loc)
            if v:
                try:
                    armor[loc] = int(v)
                except ValueError:
                    pass

    # --- Engine / gyro / cockpit / actuators / structure & armor tech ---
    eng_el = root.find("engine")
    engine = {"name": (eng_el.text or "").strip() if eng_el is not None else "",
              "rating": 0}
    if eng_el is not None:
        try:
            engine["rating"] = int(eng_el.get("rating", "0"))
        except ValueError:
            pass
    gyro_el = root.find("gyro")
    gyro = (gyro_el.text or "").strip() if gyro_el is not None else ""
    cockpit_type_el = root.find("cockpit/type")
    cockpit = (cockpit_type_el.text or "").strip() if cockpit_type_el is not None and cockpit_type_el.text else "Standard Cockpit"
    structure_type_el = root.find("structure/type")
    structure_type = (structure_type_el.text or "").strip() if structure_type_el is not None and structure_type_el.text else "Standard Structure"
    armor_type_el = root.find("armor/type")
    armor_type = (armor_type_el.text or "").strip() if armor_type_el is not None and armor_type_el.text else "Standard Armor"

    # --- Baseloadout: movement, heat sinks, actuators, equipment ---
    loadout = root.find("baseloadout")
    walk = run = jump = 0
    heat_sinks = {"count": 0, "type": ""}
    equipment = []
    actuators = {"lla": True, "rla": True, "lh": True, "rh": True}
    bf = {}
    if loadout is not None:
        bf_el = loadout.find("battleforce")
        if bf_el is not None:
            bf = dict(bf_el.attrib)
        act_el = loadout.find("actuators")
        if act_el is not None:
            for key in ("lla", "rla", "lh", "rh"):
                v = act_el.get(key)
                if v is not None:
                    actuators[key] = v.strip().upper() == "TRUE"
        # Movement: SSW stores engine rating; walk MP = rating / tons.
        # Run MP = ceil(walk * 1.5) per the construction rules (e.g. walk 7
        # -> run 11, not round-half-to-even's 10).
        if engine["rating"]:
            walk = engine["rating"] // tons if tons else 0
        run = -(-(walk * 3) // 2)  # ceil(walk * 1.5) via integer math
        hs_el = loadout.find("heatsinks")
        if hs_el is not None:
            try:
                heat_sinks["count"] = int(hs_el.get("number", "0"))
            except ValueError:
                pass
            heat_sinks["type"] = text_of(hs_el, "type")
        for eq in loadout.findall("equipment"):
            eq_name = text_of(eq, "name")
            eq_type = text_of(eq, "type")
            loc_el = eq.find("location")
            loc = loc_el.text.strip() if loc_el is not None and loc_el.text else ""
            crit = loc_el.get("index", "") if loc_el is not None else ""
            # Keep everything, including ammunition -- the faithful weapons
            # table and critical-hit table both need it.
            equipment.append({
                "name": eq_name, "type": eq_type,
                "loc": loc, "crit": crit,
            })
        # Jump jets: SSW stores them in their own <jumpjets> element (NOT in
        # <equipment>), one <location index=..>LOC</location> per jet. Jump
        # MP = number of jets. Fold each jet into the equipment list so it
        # lands in the crit table at its real slot, like the reference tool.
        jj_el = loadout.find("jumpjets")
        if jj_el is not None:
            jj_type = text_of(jj_el, "type") or "Jump Jet"
            if jj_type.endswith("Jet"):
                jj_type += "s"  # reference sheet labels these "Jump Jets"
            for loc_el in jj_el.findall("location"):
                loc = loc_el.text.strip() if loc_el.text else ""
                crit = loc_el.get("index", "")
                equipment.append({
                    "name": jj_type, "type": "jumpjet",
                    "loc": loc, "crit": crit,
                })
                jump += 1

    return {
        "name": full_name,
        "chassis": name,
        "model": model,
        "tons": tons,
        "motive": motive,
        "techBase": text_of(root, "techbase"),
        "year": text_of(root, "year"),
        "bv": text_of(root, "battle_value"),
        "cost": text_of(root, "cost"),
        "rulesLevel": text_of(root, "rules_level"),
        "move": {"walk": walk, "run": run, "jump": jump},
        "armor": armor,
        "armorType": armor_type,
        "structure": structure_for(tons),
        "structureType": structure_type,
        "engine": engine,
        "gyro": gyro,
        "cockpit": cockpit,
        "actuators": actuators,
        "heatSinks": heat_sinks,
        "equipment": equipment,
        "pv": bf.get("pv", ""),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", help="local sswMechs.ts snapshot (default: fetch)")
    args = ap.parse_args()

    if args.src:
        with open(args.src, encoding="utf-8") as f:
            ts_source = f.read()
    else:
        import requests
        print("Fetching %s ..." % SSW_URL)
        r = requests.get(SSW_URL, timeout=60)
        r.raise_for_status()
        ts_source = r.text

    docs = extract_xml_docs(ts_source)
    print("Found %d XML documents." % len(docs))

    mechs = {}
    skipped = 0
    for xml_str in docs:
        rec = parse_mech(xml_str)
        if not rec:
            skipped += 1
            continue
        mechs[norm(rec["name"])] = rec

    os.makedirs("sheets", exist_ok=True)
    out = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "count": len(mechs),
        "mechs": mechs,
    }
    with open(OUTPUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print("Wrote %s  (%d mechs, %d skipped)" % (OUTPUT, len(mechs), skipped))


if __name__ == "__main__":
    main()
