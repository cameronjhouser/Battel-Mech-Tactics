#!/usr/bin/env python3
"""
download_sheets.py
──────────────────
Downloads Classic BattleTech record sheets from mordel.net and saves them
to a local ./sheets/ folder. Once downloaded, commit the sheets/ folder to
the repo and GitHub Pages will serve them automatically.

Usage
─────
  # Single units
  python download_sheets.py "Atlas AS7-D" "Warhammer WHM-6R"

  # From a text file (one name per line)
  python download_sheets.py --txt my_units.txt

  # From the same CSV you upload to the Lance Builder
  python download_sheets.py --csv "Unit List for Company.csv"

  # Retry previously failed units
  python download_sheets.py --txt sheets/_failed.txt

Requirements
────────────
  pip install requests beautifulsoup4

Notes
─────
  • Adds a 2-second delay between requests to be polite to mordel's servers.
  • Already-downloaded sheets are skipped automatically (safe to re-run).
  • Any units not found are saved to sheets/_failed.txt for review.
  • PDFs are named exactly as the MUL unit name so the Lance Builder
    can find them automatically (e.g. "Atlas AS7-D.pdf").
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
from xml.etree import ElementTree

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    print("Missing dependencies. Run:  pip install requests beautifulsoup4")
    sys.exit(1)

# ── Configuration ──────────────────────────────────────────────────────────────
MORDEL_BASE = "https://mordel.net"
MORDEL_AJAX = f"{MORDEL_BASE}/includes/themes/Default/ajax/tro.ajax.module.php"
OUTPUT_DIR  = "sheets"
DELAY       = 2.5   # seconds between requests

USER_AGENT  = (
    "BMT-SheetDownloader/1.0 "
    "(BattleMech Tactics rulebook; "
    "github.com/cameronjhouser/Battel-Mech-Tactics)"
)

UT_CODE_TO_TYPE = {
    "bm":   "BattleMech",
    "cv":   "Combat Vehicle",
    "ba":   "Battle Armor",
    "im":   "IndustrialMech",
    "pm":   "ProtoMech",
    "aero": "Aerospace",
}

# ── Session setup ──────────────────────────────────────────────────────────────
session = requests.Session()
session.headers.update({"User-Agent": USER_AGENT})


# ── Step 1: Search mordel by name, return list of candidate dicts ──────────────
def search_mordel(name: str) -> list[dict]:
    url = f"{MORDEL_BASE}/tro.php?a=v&fltr=qf.000.Name~Contains~{quote(name)}"
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


def best_match(query: str, candidates: list[dict]) -> dict | None:
    if not candidates:
        return None
    q = query.lower()
    # Exact match
    for c in candidates:
        if c["name"].lower() == q:
            return c
    # Query contained in result or vice-versa
    for c in candidates:
        if q in c["name"].lower() or c["name"].lower() in q:
            return c
    # Fallback: first result
    return candidates[0]


# ── Step 2: POST to mordel to trigger server-side PDF generation ───────────────
def generate_sheet(mordel_id: str, ut_code: str) -> tuple[str, str] | None:
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
        print(f"    ✗ XML parse error: {e}  (response: {r.text[:120]})")
        return None

    status     = root.findtext("status", "")
    uniquename = root.findtext("uniquename", "")
    filename   = root.findtext("filename", "")
    message    = root.findtext("message", "")

    if status == "SUCCESS" and uniquename:
        return uniquename, filename
    print(f"    ✗ mordel returned status={status!r}  message={message!r}")
    return None


# ── Step 3: Download the generated PDF ────────────────────────────────────────
def download_pdf(uniquename: str, ut_code: str, display_name: str, out_path: str) -> bool:
    url = (
        f"{MORDEL_BASE}/tro.php"
        f"?a=dlf&ut={ut_code}"
        f"&file={quote(uniquename)}"
        f"&nfile={quote(display_name)}"
    )
    r = session.get(url, timeout=30, stream=True)
    r.raise_for_status()

    ct = r.headers.get("Content-Type", "")
    if "pdf" not in ct.lower() and "octet-stream" not in ct.lower():
        print(f"    ✗ Unexpected Content-Type: {ct!r}")
        return False

    with open(out_path, "wb") as f:
        for chunk in r.iter_content(chunk_size=8192):
            f.write(chunk)
    return True


# ── Full pipeline for one unit name ───────────────────────────────────────────
def process_unit(unit_name: str) -> bool:
    safe_name = re.sub(r'[<>:"/\\|?*]', "_", unit_name).strip()
    out_path  = os.path.join(OUTPUT_DIR, safe_name + ".pdf")

    print(f"\n→ {unit_name}")

    if os.path.exists(out_path):
        size_kb = os.path.getsize(out_path) // 1024
        print(f"  ✓ Already downloaded ({size_kb} KB) — skipping")
        return True

    # ── Search ────────────────────────────────────────────────────────────────
    print("  Searching mordel.net…")
    try:
        candidates = search_mordel(unit_name)
    except Exception as e:
        print(f"  ✗ Search failed: {e}")
        return False

    if not candidates:
        chassis = unit_name.split()[0]
        print(f"  No exact results — retrying with chassis name "{chassis}"…")
        time.sleep(DELAY)
        try:
            candidates = search_mordel(chassis)
        except Exception as e:
            print(f"  ✗ Chassis search failed: {e}")
            return False

    match = best_match(unit_name, candidates)
    if not match:
        print("  ✗ Unit not found on mordel.net")
        return False

    print(f'  Found: "{match["name"]}"  (mordel id={match["id"]}, type={match["ut_code"]})')
    time.sleep(DELAY)

    # ── Generate ──────────────────────────────────────────────────────────────
    print("  Requesting PDF generation…")
    try:
        result = generate_sheet(match["id"], match["ut_code"])
    except Exception as e:
        print(f"  ✗ Generation request failed: {e}")
        return False

    if not result:
        return False

    uniquename, display_name = result
    time.sleep(DELAY)

    # ── Download ──────────────────────────────────────────────────────────────
    print("  Downloading PDF…")
    try:
        ok = download_pdf(
            uniquename, match["ut_code"],
            display_name or (safe_name + ".pdf"),
            out_path,
        )
    except Exception as e:
        print(f"  ✗ Download failed: {e}")
        return False

    if ok:
        size_kb = os.path.getsize(out_path) // 1024
        print(f"  ✓ Saved: {safe_name}.pdf  ({size_kb} KB)")
    return ok


# ── Manifest writer ───────────────────────────────────────────────────────────
def write_manifest(out_dir: str) -> None:
    """Scan out_dir for PDFs and write manifest.json — consumed by the Lance Builder."""
    sheets: dict[str, str] = {}
    for fname in sorted(os.listdir(out_dir)):
        if fname.lower().endswith(".pdf") and not fname.startswith("_"):
            unit_name = fname[:-4]   # filename without .pdf == the safe unit name
            sheets[unit_name] = fname
    manifest = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "count": len(sheets),
        "sheets": sheets,
    }
    path = os.path.join(out_dir, "manifest.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
    print(f"  Manifest updated → {path}  ({len(sheets)} sheet(s))")


# ── Input helpers ──────────────────────────────────────────────────────────────
def load_txt(path: str) -> list[str]:
    with open(path, encoding="utf-8") as f:
        return [
            line.strip() for line in f
            if line.strip() and not line.startswith("#")
        ]


def load_csv(path: str) -> list[str]:
    names = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        headers = None
        for row in reader:
            if not row:
                continue
            if headers is None:
                lower = [c.strip().lower() for c in row]
                # Detect whether first row is a header
                if any(h in ("name", "unit", "mech", "unit name") for h in lower):
                    headers = lower
                    continue
                else:
                    headers = []          # no header — treat col 0 as name
            col = next(
                (i for i, h in enumerate(headers)
                 if h in ("name", "unit", "mech", "unit name")),
                0,
            )
            if len(row) > col and row[col].strip():
                names.append(row[col].strip())
    return names


# ── Entry point ────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(
        description="Download Classic BT record sheets from mordel.net",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("units", nargs="*", metavar="UNIT",
                        help='Unit names, e.g. "Atlas AS7-D"')
    parser.add_argument("--csv",   metavar="FILE",
                        help="CSV file with unit names (same format as Lance Builder)")
    parser.add_argument("--txt",   metavar="FILE",
                        help="Text file — one unit name per line")
    parser.add_argument("--out",   metavar="DIR", default=OUTPUT_DIR,
                        help=f"Output folder (default: {OUTPUT_DIR})")
    parser.add_argument("--delay", metavar="SEC", type=float, default=DELAY,
                        help=f"Seconds between requests (default: {DELAY})")
    args = parser.parse_args()

    global OUTPUT_DIR, DELAY
    OUTPUT_DIR = args.out
    DELAY      = args.delay

    # Collect names
    names: list[str] = list(args.units)
    if args.csv:
        names += load_csv(args.csv)
    if args.txt:
        names += load_txt(args.txt)

    if not names:
        parser.print_help()
        sys.exit(1)

    # Deduplicate while preserving order
    seen: set[str] = set()
    names = [n for n in names if not (n in seen or seen.add(n))]  # type: ignore

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    print(f"BMT Sheet Downloader  —  {len(names)} unit(s)  →  ./{OUTPUT_DIR}/")
    print("─" * 56)

    ok_count  = 0
    fail_list = []

    for name in names:
        if process_unit(name):
            ok_count += 1
        else:
            fail_list.append(name)
        time.sleep(DELAY)

    # ── Summary ───────────────────────────────────────────────────────────────
    print("\n" + "─" * 56)
    print(f"Complete: {ok_count}/{len(names)} downloaded to ./{OUTPUT_DIR}/")

    if fail_list:
        print(f"\nFailed ({len(fail_list)}):")
        for n in fail_list:
            print(f"  • {n}")
        fail_path = os.path.join(OUTPUT_DIR, "_failed.txt")
        with open(fail_path, "w", encoding="utf-8") as f:
            f.write("\n".join(fail_list) + "\n")
        print(f"\n  Saved to {fail_path}")
        print(f"  Retry with:  python download_sheets.py --txt {fail_path}")

    # Always (re)write manifest so it reflects current folder contents
    write_manifest(OUTPUT_DIR)

    if ok_count > 0:
        print(f"\nNext step — commit sheets to the repo so GitHub Pages serves them:")
        print(f"  cd <repo>  &&  git add sheets/  &&  git commit -m 'Add record sheets'  &&  git push")


if __name__ == "__main__":
    main()
