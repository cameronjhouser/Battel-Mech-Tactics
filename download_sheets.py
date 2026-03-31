#!/usr/bin/env python3
"""
download_sheets.py
------------------
Downloads Classic BattleTech record sheets from mordel.net and saves them
to a local ./sheets/ folder. Once downloaded, commit the sheets/ folder to
the repo and GitHub Pages will serve them automatically.

Usage
-----
  # Download all BattleMechs from the Clan Invasion era
  py download_sheets.py --all --type BattleMech --era 3050-3061

  # Download all mechs AND tanks from Succession Wars
  py download_sheets.py --all --type BattleMech --type "Combat Vehicle" --era 2781-3049

  # Download every BattleMech (takes hours -- run overnight)
  py download_sheets.py --all --type BattleMech

  # From the same CSV you upload to the Lance Builder
  py download_sheets.py --csv "Unit List for Company.csv"

  # Single units by name
  py download_sheets.py "Atlas AS7-D" "Warhammer WHM-6R"

  # Retry previously failed units
  py download_sheets.py --txt sheets/_failed.txt

Requirements
------------
  py -m pip install requests beautifulsoup4
"""

import argparse
import csv
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from urllib.parse import quote

try:
    import requests
    from bs4 import BeautifulSoup
    from xml.etree import ElementTree
except ImportError:
    print("Missing dependencies. Run:  py -m pip install requests beautifulsoup4")
    sys.exit(1)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
MORDEL_BASE = "https://mordel.net"
MORDEL_AJAX = MORDEL_BASE + "/includes/themes/Default/ajax/tro.ajax.module.php"
MUL_API     = "https://masterunitlist.azurewebsites.net/Unit/QuickList"
OUTPUT_DIR  = "sheets"
DELAY       = 2.5   # seconds between requests -- be polite

USER_AGENT = (
    "BMT-SheetDownloader/1.0 "
    "(BattleMech Tactics rulebook; "
    "github.com/cameronjhouser/Battel-Mech-Tactics)"
)

# MUL type ID lookup (case-insensitive)
MUL_TYPE_IDS = {
    "battlemech":     18,
    "combat vehicle": 23,
    "battle armor":   21,
    "aerospace":      22,
    "industrialmech": 19,
    "protomech":      20,
}

# Mordel unit-type codes
UT_CODE_TO_TYPE = {
    "bm":   "BattleMech",
    "cv":   "Combat Vehicle",
    "ba":   "Battle Armor",
    "im":   "IndustrialMech",
    "pm":   "ProtoMech",
    "aero": "Aerospace",
}

# ---------------------------------------------------------------------------
# Session
# ---------------------------------------------------------------------------
session = requests.Session()
session.headers.update({"User-Agent": USER_AGENT})


# ---------------------------------------------------------------------------
# MUL bulk query  (used by --all)
# ---------------------------------------------------------------------------
def parse_era(era_str):
    """Parse '3050-3061' into (3050, 3061). Returns None if era_str is empty."""
    if not era_str:
        return None
    parts = era_str.strip().split("-")
    try:
        if len(parts) == 2:
            return int(parts[0]), int(parts[1])
        return 0, int(parts[0])   # single year = up-to
    except ValueError:
        print("ERROR: --era must be a year range like 3050-3061")
        sys.exit(1)


def fetch_all_from_mul(unit_types, era_range):
    """
    Query the MUL API for all units of the requested types.
    The MUL requires a Name parameter, so we query A-Z and deduplicate by ID.
    Returns a list of unit name strings, filtered by era_range if given.
    """
    all_names = []

    for utype in unit_types:
        type_id = MUL_TYPE_IDS.get(utype.lower().strip())
        if type_id is None:
            valid = ", ".join(MUL_TYPE_IDS.keys())
            print("Unknown type: %r   Valid options: %s" % (utype, valid))
            continue

        print("Querying MUL for all %ss (scanning A-Z)..." % utype)
        seen_ids = set()
        all_units = []

        for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
            try:
                r = session.get(MUL_API,
                                params={"Name": letter, "Types": type_id},
                                timeout=30)
                r.raise_for_status()
                data = r.json()
            except Exception as e:
                print("  [%s] query failed: %s" % (letter, e))
                time.sleep(1)
                continue

            units = data.get("Units", data) if isinstance(data, dict) else data
            new = 0
            for u in (units or []):
                uid = u.get("Id")
                if uid and uid not in seen_ids:
                    seen_ids.add(uid)
                    all_units.append(u)
                    new += 1
            print("  [%s] %d new units (total so far: %d)" % (letter, new, len(all_units)))
            time.sleep(0.5)   # brief pause between letter queries

        if not all_units:
            print("  No results returned from MUL for type %r" % utype)
            continue

        # Apply era filter using DateIntroduced
        if era_range:
            min_y, max_y = era_range
            before = len(all_units)
            all_units = [
                u for u in all_units
                if min_y <= int(u.get("DateIntroduced") or 0) <= max_y
            ]
            print("  %d %ss in era %d-%d  (of %d total)"
                  % (len(all_units), utype, min_y, max_y, before))
        else:
            print("  %d %ss found total" % (len(all_units), utype))

        all_names.extend(u["Name"] for u in all_units if u.get("Name"))

    return all_names


# ---------------------------------------------------------------------------
# Step 1: Search mordel by name
# ---------------------------------------------------------------------------
def search_mordel(name):
    url = MORDEL_BASE + "/tro.php?a=v&fltr=qf.000.Name~Contains~" + quote(name)
    r = session.get(url, timeout=20)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")

    results = []
    pattern = re.compile(r"tro\.php\?a=vt&ut=(\w+)&id=(\d+)")
    seen_ids = set()
    for a in soup.find_all("a", href=pattern):
        m = pattern.search(a["href"])
        if m and m.group(2) not in seen_ids:
            seen_ids.add(m.group(2))
            results.append({
                "ut_code": m.group(1),
                "id":      m.group(2),
                "name":    a.get_text(strip=True),
            })
    return results


def best_match(query, candidates):
    if not candidates:
        return None
    q = query.lower()
    for c in candidates:
        if c["name"].lower() == q:
            return c
    for c in candidates:
        if q in c["name"].lower() or c["name"].lower() in q:
            return c
    return candidates[0]


# ---------------------------------------------------------------------------
# Step 2: POST to mordel to trigger PDF generation
# ---------------------------------------------------------------------------
def generate_sheet(mordel_id, ut_code):
    unit_type = UT_CODE_TO_TYPE.get(ut_code, "BattleMech")
    payload = {
        "action":      "GenerateFormat",
        "format":      "PDF",
        "unitid":      mordel_id,
        "unittype":    unit_type,
        "custom":      "0",
        "warriordata": "",
        "ammo":        "",
    }
    r = session.post(MORDEL_AJAX, data=payload, timeout=30)
    r.raise_for_status()

    try:
        root = ElementTree.fromstring(r.text)
    except ElementTree.ParseError as e:
        print("    XML parse error: %s  (response: %s)" % (e, r.text[:120]))
        return None

    status     = root.findtext("status", "")
    uniquename = root.findtext("uniquename", "")
    filename   = root.findtext("filename", "")
    message    = root.findtext("message", "")

    if status == "SUCCESS" and uniquename:
        return uniquename, filename
    print("    mordel error: status=%r  message=%r" % (status, message))
    return None


# ---------------------------------------------------------------------------
# Step 3: Download the generated PDF
# ---------------------------------------------------------------------------
def download_pdf(uniquename, ut_code, display_name, out_path):
    url = (MORDEL_BASE + "/tro.php"
           + "?a=dlf&ut=" + ut_code
           + "&file=" + quote(uniquename)
           + "&nfile=" + quote(display_name))
    r = session.get(url, timeout=30, stream=True)
    r.raise_for_status()

    ct = r.headers.get("Content-Type", "")
    if "pdf" not in ct.lower() and "octet-stream" not in ct.lower():
        print("    Unexpected Content-Type: %r" % ct)
        return False

    with open(out_path, "wb") as f:
        for chunk in r.iter_content(chunk_size=8192):
            f.write(chunk)
    return True


# ---------------------------------------------------------------------------
# Full pipeline for one unit name
# ---------------------------------------------------------------------------
def process_unit(unit_name):
    safe_name = re.sub(r'[<>:"/\\|?*]', "_", unit_name).strip()
    out_path  = os.path.join(OUTPUT_DIR, safe_name + ".pdf")

    print("\n-> %s" % unit_name)

    if os.path.exists(out_path):
        size_kb = os.path.getsize(out_path) // 1024
        print("  Already downloaded (%d KB) -- skipping" % size_kb)
        return True

    # Search
    print("  Searching mordel.net...")
    try:
        candidates = search_mordel(unit_name)
    except Exception as e:
        print("  Search failed: %s" % e)
        return False

    if not candidates:
        chassis = unit_name.split()[0]
        print('  No results -- retrying with chassis name "%s"...' % chassis)
        time.sleep(DELAY)
        try:
            candidates = search_mordel(chassis)
        except Exception as e:
            print("  Chassis search failed: %s" % e)
            return False

    match = best_match(unit_name, candidates)
    if not match:
        print("  Not found on mordel.net")
        return False

    print('  Found: "%s"  (mordel id=%s, type=%s)'
          % (match["name"], match["id"], match["ut_code"]))
    time.sleep(DELAY)

    # Generate
    print("  Requesting PDF generation...")
    try:
        result = generate_sheet(match["id"], match["ut_code"])
    except Exception as e:
        print("  Generation failed: %s" % e)
        return False

    if not result:
        return False

    uniquename, display_name = result
    time.sleep(DELAY)

    # Download
    print("  Downloading PDF...")
    try:
        ok = download_pdf(
            uniquename, match["ut_code"],
            display_name or (safe_name + ".pdf"),
            out_path,
        )
    except Exception as e:
        print("  Download failed: %s" % e)
        return False

    if ok:
        size_kb = os.path.getsize(out_path) // 1024
        print("  Saved: %s.pdf  (%d KB)" % (safe_name, size_kb))
    return ok


# ---------------------------------------------------------------------------
# Manifest writer
# ---------------------------------------------------------------------------
def write_manifest(out_dir):
    sheets = {}
    for fname in sorted(os.listdir(out_dir)):
        if fname.lower().endswith(".pdf") and not fname.startswith("_"):
            sheets[fname[:-4]] = fname   # key = name without .pdf
    manifest = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "count":     len(sheets),
        "sheets":    sheets,
    }
    path = os.path.join(out_dir, "manifest.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
    print("Manifest updated -> %s  (%d sheets)" % (path, len(sheets)))


# ---------------------------------------------------------------------------
# Input helpers
# ---------------------------------------------------------------------------
def load_txt(path):
    with open(path, encoding="utf-8") as f:
        return [line.strip() for line in f
                if line.strip() and not line.startswith("#")]


def load_csv(path):
    names = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        headers = None
        for row in reader:
            if not row:
                continue
            if headers is None:
                lower = [c.strip().lower() for c in row]
                if any(h in ("name", "unit", "mech", "unit name") for h in lower):
                    headers = lower
                    continue
                else:
                    headers = []
            col = next(
                (i for i, h in enumerate(headers)
                 if h in ("name", "unit", "mech", "unit name")),
                0,
            )
            if len(row) > col and row[col].strip():
                names.append(row[col].strip())
    return names


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main():
    global OUTPUT_DIR, DELAY   # must be declared before any reference to these names

    parser = argparse.ArgumentParser(
        description="Download Classic BT record sheets from mordel.net",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("units", nargs="*", metavar="UNIT",
                        help='Unit names, e.g. "Atlas AS7-D"')
    parser.add_argument("--all",    action="store_true",
                        help="Fetch unit list from MUL API instead of providing names")
    parser.add_argument("--type",   metavar="TYPE", action="append", dest="types",
                        help='Unit type for --all (e.g. BattleMech, "Combat Vehicle"). '
                             "Repeat for multiple types.")
    parser.add_argument("--era",    metavar="RANGE",
                        help='Year range for --all, e.g. 3050-3061 or 2781-3049')
    parser.add_argument("--csv",    metavar="FILE",
                        help="CSV file with unit names")
    parser.add_argument("--txt",    metavar="FILE",
                        help="Text file -- one unit name per line")
    parser.add_argument("--out",    metavar="DIR", default=OUTPUT_DIR,
                        help="Output folder (default: sheets)")
    parser.add_argument("--delay",  metavar="SEC", type=float, default=DELAY,
                        help="Seconds between requests (default: 2.5)")
    args = parser.parse_args()

    OUTPUT_DIR = args.out
    DELAY      = args.delay

    names = list(args.units)

    # --all: pull unit list from MUL
    if args.all:
        unit_types = args.types or ["BattleMech"]
        era_range  = parse_era(args.era)
        print("Fetching unit list from MUL...")
        mul_names = fetch_all_from_mul(unit_types, era_range)
        if not mul_names:
            print("No units returned from MUL. Check your --type and --era values.")
            sys.exit(1)
        names += mul_names

    if args.csv:
        names += load_csv(args.csv)
    if args.txt:
        names += load_txt(args.txt)

    if not names:
        parser.print_help()
        sys.exit(1)

    # Deduplicate while preserving order
    seen = set()
    names = [n for n in names if not (n in seen or seen.add(n))]

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    print("\nBMT Sheet Downloader  --  %d unit(s)  ->  ./%s/" % (len(names), OUTPUT_DIR))
    print("-" * 56)

    ok_count  = 0
    fail_list = []

    for name in names:
        if process_unit(name):
            ok_count += 1
        else:
            fail_list.append(name)
        time.sleep(DELAY)

    # Summary
    print("\n" + "-" * 56)
    print("Complete: %d/%d downloaded to ./%s/" % (ok_count, len(names), OUTPUT_DIR))

    if fail_list:
        print("\nFailed (%d):" % len(fail_list))
        for n in fail_list:
            print("  * %s" % n)
        fail_path = os.path.join(OUTPUT_DIR, "_failed.txt")
        with open(fail_path, "w", encoding="utf-8") as f:
            f.write("\n".join(fail_list) + "\n")
        print("\n  Saved to %s" % fail_path)
        print("  Retry with:  py download_sheets.py --txt %s" % fail_path)

    write_manifest(OUTPUT_DIR)

    if ok_count > 0:
        print("\nNext step -- commit sheets to the repo:")
        print("  git add sheets/  &&  git commit -m \"Add record sheets\"  &&  git push")


if __name__ == "__main__":
    main()
