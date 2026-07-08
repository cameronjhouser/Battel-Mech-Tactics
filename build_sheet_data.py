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

    # --- Baseloadout: movement, heat sinks, equipment ---
    loadout = root.find("baseloadout")
    walk = run = jump = 0
    heat_sinks = {"count": 0, "type": ""}
    equipment = []
    bf = {}
    if loadout is not None:
        bf_el = loadout.find("battleforce")
        if bf_el is not None:
            bf = dict(bf_el.attrib)
        # Movement: SSW stores engine rating; walk MP = rating / tons.
        # Prefer explicit if present, else compute from engine.
        eng = root.find("engine")
        if eng is not None:
            try:
                rating = int(eng.get("rating", "0"))
                walk = rating // tons if tons else 0
            except ValueError:
                walk = 0
        run = int(round(walk * 1.5))
        # Jump jets: count jumpjet equipment entries.
        hs_el = loadout.find("heatsinks")
        if hs_el is not None:
            try:
                heat_sinks["count"] = int(hs_el.get("number", "0"))
            except ValueError:
                pass
            heat_sinks["type"] = text_of(hs_el, "type")
        jj = 0
        for eq in loadout.findall("equipment"):
            eq_name = text_of(eq, "name")
            eq_type = text_of(eq, "type")
            loc_el = eq.find("location")
            loc = loc_el.text.strip() if loc_el is not None and loc_el.text else ""
            crit = loc_el.get("index", "") if loc_el is not None else ""
            if "jump jet" in eq_name.lower():
                jj += 1
            # Skip ammunition/actuator noise for the weapons table; keep
            # weapons + notable gear (energy/ballistic/missile/misc).
            if eq_type in ("energy", "ballistic", "missile", "physical") \
                    or ("jump jet" not in eq_name.lower()
                        and eq_type not in ("ammunition",)):
                equipment.append({
                    "name": eq_name, "type": eq_type,
                    "loc": loc, "crit": crit,
                })
        jump = jj

    return {
        "name": full_name,
        "chassis": name,
        "model": model,
        "tons": tons,
        "motive": motive,
        "techBase": text_of(root, "techbase"),
        "year": text_of(root, "year"),
        "bv": text_of(root, "battle_value"),
        "rulesLevel": text_of(root, "rules_level"),
        "move": {"walk": walk, "run": run, "jump": jump},
        "armor": armor,
        "structure": structure_for(tons),
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
