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
  py build_sheet_data.py --src local.ts --mtf-dir path/to/mm-data/data/mekfiles/meks

The --mtf-dir option merges the MegaMek unit database (MTF files) on top of
the SSW data — ~4,100 mechs vs SSW's ~500, with authoritative per-location
critical-slot lists and MUL ids. Get it with:

  git clone --depth 1 --filter=blob:none --sparse \
      https://github.com/MegaMek/mm-data.git
  cd mm-data && git sparse-checkout set data/mekfiles/meks

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
    ap.add_argument("--mtf-dir", help="MegaMek mm-data meks directory (adds/replaces from MTF files)")
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

    aliases = {}
    by_mul = {}
    if args.mtf_dir:
        merge_mtf(mechs, aliases, by_mul, args.mtf_dir)

    os.makedirs("sheets", exist_ok=True)
    out = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "count": len(mechs),
        "mechs": mechs,
        "aliases": aliases,
        "byMul": by_mul,
    }
    with open(OUTPUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print("Wrote %s  (%d mechs, %d aliases, %d MUL ids, %d skipped)"
          % (OUTPUT, len(mechs), len(aliases), len(by_mul), skipped))


# ═══════════════════════════════════════════════════════════════════════════
# MegaMek MTF ingestion (MegaMek/mm-data, CC BY-NC-SA 4.0 fan data — same
# informal footing as the SSW and mordel.net data already used here).
#
# MTF files are strictly better source material than the SSW XML where both
# exist: they carry the COMPLETE per-location critical-slot lists (including
# Endo Steel / Ferro-Fibrous filler we previously couldn't place), rear
# armor, and the unit's MUL id, which lets the app match units exactly
# instead of by normalized name. MTF records therefore REPLACE SSW records
# for the same unit; bv/cost are backfilled from the SSW record since MTF
# doesn't carry them.
# ═══════════════════════════════════════════════════════════════════════════

MTF_LOC_KEYS = {
    "left arm": "la", "right arm": "ra", "left torso": "lt",
    "right torso": "rt", "center torso": "ct", "head": "hd",
    "left leg": "ll", "right leg": "rl",
    # Quad / tripod locations (kept in the data so those units can render
    # once quad silhouettes are added; the app falls back to PDF for now).
    "front left leg": "fll", "front right leg": "frl",
    "rear left leg": "rll", "rear right leg": "rrl",
    "center leg": "cl",
}
MTF_ARMOR_KEYS = {
    "la armor": "la", "ra armor": "ra", "lt armor": "lt", "rt armor": "rt",
    "ct armor": "ct", "hd armor": "hd", "ll armor": "ll", "rl armor": "rl",
    "rtl armor": "ltr", "rtr armor": "rtr", "rtc armor": "ctr",
    "fll armor": "fll", "frl armor": "frl",
    "rll armor": "rll", "rrl armor": "rrl", "cl armor": "cl",
}

# Ammo shots per ton, for crit-slot labels ("Ammo (LRM-15) 8/8"). Mirror of
# index.html's RS_AMMO_SHOTS.
MTF_AMMO_SHOTS = {
    "AC/2": 45, "Light AC/2": 45, "Ultra AC/2": 45, "Rotary AC/2": 45, "LB 2-X AC": 45,
    "AC/5": 20, "Light AC/5": 20, "Ultra AC/5": 20, "Rotary AC/5": 20, "LB 5-X AC": 20,
    "AC/10": 10, "Ultra AC/10": 10, "LB 10-X AC": 10,
    "AC/20": 5, "Ultra AC/20": 5, "LB 20-X AC": 5,
    "LRM-5": 24, "LRM-10": 12, "LRM-15": 8, "LRM-20": 6,
    "SRM-2": 50, "SRM-4": 25, "SRM-6": 15,
    "Streak SRM-2": 50, "Streak SRM-4": 25, "Streak SRM-6": 15,
    "MRM-10": 24, "MRM-20": 12, "MRM-30": 8, "MRM-40": 6,
    "Machine Gun": 200, "Light Machine Gun": 200, "Heavy Machine Gun": 100,
    "Gauss Rifle": 8, "Light Gauss Rifle": 8, "Heavy Gauss Rifle": 4,
    "Anti-Missile System": 24, "Narc Missile Beacon": 6, "iNarc Launcher": 4,
    "ATM-3": 20, "ATM-6": 10, "ATM-9": 7, "ATM-12": 5,
}

# Compact MegaMek internal codes -> printable names. Anything not matched
# falls back to a generic de-camel-casing, so unknown gear still renders.
MTF_CODE_RULES = [
    (r"^ERPPC$", "ER PPC"), (r"^PPC$", "PPC"),
    (r"^LPPC$", "Light PPC"), (r"^HeavyPPC$", "Heavy PPC"), (r"^SNPPC$", "Snub-Nose PPC"),
    (r"^ER(Large|Medium|Small|Micro)Laser$", lambda m: "ER %s Laser" % m.group(1)),
    (r"^(Large|Medium|Small|Micro)Laser$", lambda m: "%s Laser" % m.group(1)),
    (r"^(Large|Medium|Small|Micro)PulseLaser$", lambda m: "%s Pulse Laser" % m.group(1)),
    (r"^(Large|Medium|Small)XPulseLaser$", lambda m: "%s X-Pulse Laser" % m.group(1)),
    (r"^ER(Large|Medium|Small)PulseLaser$", lambda m: "ER %s Pulse Laser" % m.group(1)),
    (r"^Heavy(Large|Medium|Small)Laser$", lambda m: "Heavy %s Laser" % m.group(1)),
    (r"^LBXAC(\d+)$", lambda m: "LB %s-X AC" % m.group(1)),
    (r"^UltraAC(\d+)$", lambda m: "Ultra AC/%s" % m.group(1)),
    (r"^RotaryAC(\d+)$", lambda m: "Rotary AC/%s" % m.group(1)),
    (r"^RAC(\d+)$", lambda m: "Rotary AC/%s" % m.group(1)),
    (r"^LAC(\d+)$", lambda m: "Light AC/%s" % m.group(1)),
    (r"^AC(\d+)$", lambda m: "AC/%s" % m.group(1)),
    (r"^LRM(\d+)$", lambda m: "LRM-%s" % m.group(1)),
    (r"^SRM(\d+)$", lambda m: "SRM-%s" % m.group(1)),
    (r"^StreakSRM(\d+)$", lambda m: "Streak SRM-%s" % m.group(1)),
    (r"^StreakLRM(\d+)$", lambda m: "Streak LRM-%s" % m.group(1)),
    (r"^MRM(\d+)$", lambda m: "MRM-%s" % m.group(1)),
    (r"^MML(\d+)$", lambda m: "MML-%s" % m.group(1)),
    (r"^ATM(\d+)$", lambda m: "ATM-%s" % m.group(1)),
    (r"^RL(\d+)$", lambda m: "Rocket Launcher %s" % m.group(1)),
    (r"^RocketLauncher(\d+)$", lambda m: "Rocket Launcher %s" % m.group(1)),
    (r"^MG$", "Machine Gun"), (r"^LMG$", "Light Machine Gun"), (r"^HMG$", "Heavy Machine Gun"),
    (r"^GaussRifle$", "Gauss Rifle"), (r"^LGaussRifle$", "Light Gauss Rifle"),
    (r"^HGaussRifle$", "Heavy Gauss Rifle"), (r"^ImprovedHeavyGaussRifle$", "Improved Heavy Gauss Rifle"),
    (r"^APGaussRifle$", "AP Gauss Rifle"), (r"^HAG(\d+)$", lambda m: "HAG/%s" % m.group(1)),
    (r"^Flamer$", "Flamer"), (r"^ERFlamer$", "ER Flamer"), (r"^HeavyFlamer$", "Heavy Flamer"),
    (r"^PlasmaRifle$", "Plasma Rifle"), (r"^PlasmaCannon$", "Plasma Cannon"),
    (r"^AntiMissileSystem$", "Anti-Missile System"), (r"^AMS$", "Anti-Missile System"),
    (r"^LaserAntiMissileSystem$", "Laser AMS"), (r"^LaserAMS$", "Laser AMS"),
    (r"^NarcBeacon$", "Narc Missile Beacon"), (r"^iNarcLauncher$", "iNarc Launcher"),
    (r"^TAG$", "TAG"), (r"^LightTAG$", "Light TAG"),
    (r"^C3SlaveUnit$", "C3 Computer (Slave)"), (r"^C3MasterComputer$", "C3 Computer (Master)"),
    (r"^C3MasterBoostedSystemUnit$", "C3 Boosted (Master)"), (r"^C3BoostedSystemSlaveUnit$", "C3 Boosted (Slave)"),
    (r"^ImprovedC3CPU$", "Improved C3 Computer"),
    (r"^TargetingComputer$", "Targeting Computer"), (r"^Targeting Computer$", "Targeting Computer"),
    (r"^ECMSuite$", "ECM Suite"), (r"^GuardianECMSuite$", "Guardian ECM Suite"),
    (r"^AngelECMSuite$", "Angel ECM Suite"), (r"^BeagleActiveProbe$", "Beagle Active Probe"),
    (r"^ActiveProbe$", "Active Probe"), (r"^BloodhoundActiveProbe$", "Bloodhound Active Probe"),
    (r"^SmallVSPLaser$", "Small VSP Laser"), (r"^MediumVSPLaser$", "Medium VSP Laser"),
    (r"^LargeVSPLaser$", "Large VSP Laser"),
    (r"^iATM(\d+)$", lambda m: "iATM-%s" % m.group(1)),
    (r"^Mek(.*)$", lambda m: m.group(1)),
]

MTF_CODE_RULES_COMPILED = None


def mtf_decode(token):
    """Turn a MegaMek internal code like CLLBXAC10 into 'LB 10-X AC'."""
    global MTF_CODE_RULES_COMPILED
    if MTF_CODE_RULES_COMPILED is None:
        MTF_CODE_RULES_COMPILED = [(re.compile(p), r) for p, r in MTF_CODE_RULES]
    for pat, repl in MTF_CODE_RULES_COMPILED:
        m = pat.match(token)
        if m:
            return repl(m) if callable(repl) else repl
    # Generic fallback: split camel case / letter-digit boundaries.
    s = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", token)
    s = re.sub(r"(?<=[A-Za-z])(?=\d)", " ", s)
    return s


def mtf_clean_slot(raw, engine_label):
    """Normalize one crit-slot line to a printable label (or None if empty)."""
    s = raw.strip()
    if not s or s.lower() in ("-empty-", "- empty -"):
        return None
    rear = "(R)" in s
    s = s.replace("(OMNIPOD)", "").replace("(omnipod)", "")
    s = s.replace("(ARMORED)", "").replace("(R)", "").strip()
    low = s.lower()

    if low in ("fusion engine", "engine"):
        return engine_label
    if low == "gyro":
        return "Standard Gyro"
    if re.fullmatch(r"(is|clan)? ?(xl|compact|heavy[- ]duty) gyro", low):
        return re.sub(r"^(IS|Clan)\s+", "", s)
    if low in ("hip", "shoulder", "foot actuator", "life support", "sensors", "cockpit",
               "jump jet", "improved jump jet",
               "upper arm actuator", "lower arm actuator", "hand actuator",
               "upper leg actuator", "lower leg actuator"):
        return s.title() if s != s.title() else s
    if re.search(r"ferro[- ]fibrous|endo[- ]?steel|endo[- ]composite|ferro[- ]lamellor|reinforced|composite", low):
        return re.sub(r"^(IS|Clan)\s+", "", s)
    if low in ("heat sink", "double heat sink", "isdoubleheatsink", "cldoubleheatsink", "laser heat sink"):
        return "Double Heat Sink" if "double" in low else ("Laser Heat Sink" if "laser" in low else "Heat Sink")
    if "case" in low and len(s) <= 8:
        return "CASE II" if "ii" in low else "CASE"

    # Ammo lines: "Clan Ammo LRM-15", "IS Ammo AC/20", "CLSRM6 Ammo", ...
    if re.search(r"\bammo\b", low):
        w = re.sub(r"^(IS|Clan|CL)\s*", "", s, flags=re.I)
        w = re.sub(r"\bammo\b", "", w, flags=re.I).strip(" -")
        w = re.sub(r"\s*\(.*\)$", "", w).strip()
        w = re.sub(r"\bhalf\b", "", w, flags=re.I).strip(" -")
        if re.fullmatch(r"[A-Z0-9]+", w):
            w = mtf_decode(re.sub(r"^(CL|IS)", "", w))
        w = re.sub(r"^(LRM|SRM|MRM|MML|ATM)[ ](\d+)", r"\1-\2", w)
        if w == "Gauss":
            w = "Gauss Rifle"
        shots = MTF_AMMO_SHOTS.get(w)
        return ("Ammo (%s) %d/%d" % (w, shots, shots)) if shots else ("Ammo (%s)" % w)

    # Weapon / equipment codes: CLLBXAC10, ISERLargeLaser, CLERPPC, and
    # prefixed readable names like "ISTargeting Computer".
    body = s
    m = re.match(r"^(CL|IS)(?=[A-Z0-9]|i[A-Z])", body)
    if m:
        rest = body[m.end():]
        body = mtf_decode(rest) if " " not in rest else rest
    else:
        body = re.sub(r"^(IS|Clan)\s+", "", body)
    body = re.sub(r"^(LRM|SRM|MRM|MML|ATM)[ ](\d+)", r"\1-\2", body)
    body = body.replace("Auto Cannon", "AC").replace("Autocannon", "AC")
    if rear:
        body += " [R]"
    return body


def mtf_engine_label(engine_line):
    """'350 XL (Clan) Engine' -> 'XL Fusion'; 'Fusion Engine' -> 'Standard Fusion'."""
    s = re.sub(r"^\d+\s*", "", engine_line or "").strip()
    s = re.sub(r"\((IS|Clan)\)", "", s).strip()
    s = re.sub(r"\s*Engine$", "", s, flags=re.I).strip()
    if not s or s.lower() == "fusion":
        return "Standard Fusion"
    if "fusion" not in s.lower() and not re.search(r"ICE|fuel cell|fission", s, re.I):
        s += " Fusion"
    return s


def mtf_weapon_type(name):
    n = name.lower()
    if re.search(r"lrm|srm|mrm|mml|atm|rocket|narc|thunderbolt", n): return "missile"
    if re.search(r"laser|ppc|flamer|plasma", n): return "energy"
    if re.search(r"ac/|ac\b|gauss|machine gun|rifle|hag", n): return "ballistic"
    if re.search(r"hatchet|sword|claw|mace|vibro", n): return "physical"
    return "equipment"


def parse_mtf(text):
    lines = text.splitlines()
    kv = {}
    crits = {}
    weapons = []
    i = 0
    cur_loc = None
    weapons_left = 0
    for ln in lines:
        s = ln.strip()
        if s.startswith("#"):
            continue
        if cur_loc is not None:
            if not s:
                cur_loc = None
                continue
            if re.match(r"^[A-Za-z ]+:$", s):  # next location header
                cur_loc = MTF_LOC_KEYS.get(s[:-1].strip().lower())
                if cur_loc is not None:
                    crits[cur_loc] = []
                continue
            if cur_loc:
                crits[cur_loc].append(s)
            continue
        if weapons_left > 0 and s:
            weapons.append(s)
            weapons_left -= 1
            continue
        if re.match(r"^[A-Za-z ]+:$", s) and s[:-1].strip().lower() in MTF_LOC_KEYS:
            cur_loc = MTF_LOC_KEYS[s[:-1].strip().lower()]
            crits[cur_loc] = []
            continue
        m = re.match(r"^([^:]+):(.*)$", s)
        if m:
            key = m.group(1).strip().lower()
            val = m.group(2).strip()
            if key == "weapons":
                try:
                    weapons_left = int(val)
                except ValueError:
                    pass
                continue
            if key not in kv:
                kv[key] = val
    return kv, crits, weapons


def mtf_record(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        kv, crit_raw, weapon_lines = parse_mtf(f.read())

    config = kv.get("config", "")
    cl = config.lower()
    if cl.startswith("biped"):
        motive = "Biped"
    elif cl.startswith("quadvee"):
        motive = "QuadVee"
    elif cl.startswith("quad"):
        motive = "Quad"
    elif cl.startswith("tripod"):
        motive = "Tripod"
    elif cl.startswith("lam"):
        motive = "LAM"
    else:
        return None
    try:
        tons = int(float(kv.get("mass", "0")))
    except ValueError:
        return None
    structure = structure_for(tons)
    if not structure:
        return None

    chassis = kv.get("chassis", "").strip()
    clanname = kv.get("clanname", "").strip()
    model = kv.get("model", "").strip()
    display_chassis = clanname or chassis
    if not display_chassis:
        return None
    full_name = ("%s %s" % (display_chassis, model)).strip()
    alt_name = ("%s %s" % (chassis, model)).strip() if clanname else ""

    eng_line = kv.get("engine", "")
    m = re.match(r"^(\d+)", eng_line)
    rating = int(m.group(1)) if m else 0
    walk = 0
    try:
        walk = int(kv.get("walk mp", "0"))
    except ValueError:
        pass
    if not walk and rating and tons:
        walk = rating // tons
    run = -(-(walk * 3) // 2)
    try:
        jump = int(kv.get("jump mp", "0") or 0)
    except ValueError:
        jump = 0

    armor = {}
    for k, loc in MTF_ARMOR_KEYS.items():
        v = kv.get(k)
        if v is not None:
            try:
                armor[loc] = int(re.sub(r"[^0-9]", "", v) or 0)
            except ValueError:
                pass

    hs = kv.get("heat sinks", "")
    hs_m = re.match(r"^(\d+)\s*(.*)$", hs)
    hs_count = int(hs_m.group(1)) if hs_m else 0
    hs_type_raw = (hs_m.group(2) if hs_m else "").strip()
    hs_type = ("Double Heat Sink" if re.search(r"double|laser", hs_type_raw, re.I)
               else "Single Heat Sink")

    eng_label = mtf_engine_label(eng_line)
    crits = {}
    for loc, rows in crit_raw.items():
        n = 6 if loc in ("hd", "ll", "rl", "fll", "frl", "rll", "rrl", "cl") else 12
        cleaned = [mtf_clean_slot(r, eng_label) for r in rows[:n]]
        cleaned += [None] * (n - len(cleaned))
        crits[loc] = cleaned

    equipment = []
    for wl in weapon_lines:
        m = re.match(r"^(?:(\d+)\s+)?(.+?),\s*([A-Za-z ]+?)(\s*\(R\))?$", wl.strip())
        if not m:
            continue
        count = int(m.group(1)) if m.group(1) else 1
        wname = m.group(2).strip()
        wname = re.sub(r"^(IS|Clan|CL)\s+", "", wname)
        wname = re.sub(r"^(LRM|SRM|MRM|MML|ATM)[ ](\d+)", r"\1-\2", wname)
        loc_key = MTF_LOC_KEYS.get(m.group(3).strip().lower(), "")
        rear = bool(m.group(4))
        for _ in range(count):
            equipment.append({
                "name": ("(R) " if rear else "") + wname,
                "type": mtf_weapon_type(wname),
                "loc": loc_key.upper(),
                "crit": "",
            })
    # Ammo entries for the weapons table, derived from the crit slots.
    for loc, rows in crits.items():
        for r in rows:
            if r and r.startswith("Ammo ("):
                base = re.match(r"^Ammo \(([^)]*)\)", r).group(1)
                equipment.append({"name": "@ " + base, "type": "ammunition",
                                  "loc": loc.upper(), "crit": ""})
    # Notable non-weapon gear lives only in the crit slots in MTF (the
    # Weapons block is weapons-only) — surface it in the equipment list so
    # the weapons table and the Targeting Computer to-hit logic see it.
    NOTABLE = {"Targeting Computer", "Guardian ECM Suite", "ECM Suite",
               "Angel ECM Suite", "Beagle Active Probe", "Active Probe",
               "Bloodhound Active Probe", "C3 Computer (Slave)",
               "C3 Computer (Master)", "Improved C3 Computer",
               "CASE", "CASE II"}
    for loc, rows in crits.items():
        prev = None
        for r in rows:
            if r in NOTABLE and r != prev:
                equipment.append({"name": r, "type": "equipment",
                                  "loc": loc.upper(), "crit": ""})
            prev = r

    try:
        mul_id = int(kv.get("mul id", "0") or 0)
    except ValueError:
        mul_id = 0

    return {
        "name": full_name,
        "altName": alt_name,
        "chassis": display_chassis,
        "model": model,
        "mul": mul_id,
        "tons": tons,
        "motive": motive,
        "techBase": kv.get("techbase", ""),
        "year": kv.get("era", ""),
        "bv": "",
        "cost": "",
        "rulesLevel": kv.get("rules level", ""),
        "move": {"walk": walk, "run": run, "jump": jump},
        "armor": armor,
        "armorType": kv.get("armor", ""),
        "structure": structure,
        "structureType": kv.get("structure", ""),
        "engine": {"name": eng_line, "rating": rating},
        "gyro": "",
        "cockpit": kv.get("cockpit", "Standard Cockpit"),
        "heatSinks": {"count": hs_count, "type": hs_type},
        "equipment": equipment,
        "crits": crits,
        "pv": "",
    }


def merge_mtf(mechs, aliases, by_mul, mtf_dir):
    import glob as globmod
    files = globmod.glob(os.path.join(mtf_dir, "**", "*.mtf"), recursive=True)
    print("Parsing %d MTF files from %s ..." % (len(files), mtf_dir))
    added = replaced = skipped = 0
    for path in sorted(files):
        try:
            rec = mtf_record(path)
        except Exception as e:
            print("  ! %s: %s" % (os.path.basename(path), e))
            skipped += 1
            continue
        if not rec:
            skipped += 1
            continue
        key = norm(rec["name"])
        old = mechs.get(key)
        if old:
            # MTF replaces SSW (authoritative crit lists), keeping the SSW
            # bv/cost/pv the MTF format doesn't carry.
            rec["bv"] = old.get("bv", "")
            rec["cost"] = old.get("cost", "")
            rec["pv"] = old.get("pv", "")
            replaced += 1
        else:
            added += 1
        mechs[key] = rec
        if rec["altName"]:
            akey = norm(rec["altName"])
            if akey != key and akey not in mechs:
                aliases[akey] = key
        if rec["mul"]:
            by_mul[str(rec["mul"])] = key
    print("MTF merge: %d added, %d replaced, %d skipped (non-biped/parse)"
          % (added, replaced, skipped))


if __name__ == "__main__":
    main()
