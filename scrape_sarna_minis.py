#!/usr/bin/env python3
"""Scrape Catalyst Game Labs plastic-miniature data from Sarna BTW.

Pulls the wikitext of https://www.sarna.net/wiki/Miniatures_-_Catalyst_Game_Labs
via Sarna's MediaWiki API and extracts, per miniature: base number(s),
catalog number(s), model/variant designations, chassis name, and the box
set / ForcePack it ships in (its own column in the modern tables; the
enclosing section heading is kept as extra context either way). Writes
data/sarna-minis.json (consumed by the Skirmish Force Builder) and a
human-readable data/sarna-minis.csv.

Notes on the source tables (verified against the live page, July 2026):
  - Modern (2019+) tables:  Image | Base Number | Catalog Number | Model |
    Name | Parts | Manufacturer | Year | Material | Box Set(s)
  - Classics (2007-2014) tables have no Base Number column (those minis
    predate stamped base numbers) — their rows still get catalog/model data.
  - Base numbers can be multiple ("3-50 / 3-49"), catalog numbers can be
    multiple ("3500B/35713"), and Model cells list several variants
    ("GRF-1N / -3N / C").

Intended to run from a cron job on a box with git push access, e.g.:

    # First of the month, 03:00 — refresh Sarna minis data
    0 3 1 * * cd /path/to/Battel-Mech-Tactics && ./scrape_sarna_minis.py \
        && git add data/ && git diff --cached --quiet \
        || (git commit -m "Update Sarna miniatures data" && git push)

Run with --selftest to validate the wikitext parser against an embedded
sample (no network); use this after any parser change.

Sarna content is CC BY-NC-SA licensed; the output files carry attribution.
"""

import argparse
import csv
import json
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

PAGE = "Miniatures - Catalyst Game Labs"
API = "https://www.sarna.net/wiki/api.php"
USER_AGENT = (
    "BattelMechTactics-minis-sync/1.0 "
    "(https://github.com/cameronjhouser/Battel-Mech-Tactics; monthly cron)"
)


def fetch_wikitext() -> str:
    params = urllib.parse.urlencode({
        "action": "parse",
        "page": PAGE,
        "prop": "wikitext",
        "format": "json",
        "formatversion": "2",
    })
    req = urllib.request.Request(f"{API}?{params}", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.load(resp)
    return data["parse"]["wikitext"]


# ── Wikitext cell cleanup ────────────────────────────────────────────────────

def clean_cell(raw: str) -> str:
    s = raw
    # Cell attribute prefix: style="..." | actual content
    if "|" in s.split("[[", 1)[0].split("{{", 1)[0]:
        head, _, tail = s.partition("|")
        if "=" in head and "[[" not in head:
            s = tail
    s = re.sub(r"<ref[^>]*/>", "", s)
    s = re.sub(r"<ref[^>]*>.*?</ref>", "", s, flags=re.S)
    s = re.sub(r"\[\[(?:File|Image):[^\]]*\]\]", "", s, flags=re.I)
    # Nested-once templates, then any remaining simple templates
    s = re.sub(r"\{\{[^{}]*\{\{[^{}]*\}\}[^{}]*\}\}", "", s)
    s = re.sub(r"\{\{[^{}]*\}\}", "", s)
    # [[target|label]] -> label, [[target]] -> target
    s = re.sub(r"\[\[[^\]|]*\|([^\]]*)\]\]", r"\1", s)
    s = re.sub(r"\[\[([^\]]*)\]\]", r"\1", s)
    s = re.sub(r"<br\s*/?>", " / ", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    s = s.replace("'''", "").replace("''", "")
    return re.sub(r"\s+", " ", s).strip()


def split_multi(cell: str) -> list[str]:
    """Model cells: 'GRF-1N / -3N / C' -> ['GRF-1N', '-3N', 'C'].

    Split on slashes only — model designations contain internal spaces
    ('Prime Config'). Partial variants ('-3N') are kept as written.
    """
    parts = [p.strip() for p in re.split(r"\s*/\s*", cell) if p.strip()]
    return parts or ([cell.strip()] if cell.strip() else [])


def split_codes(cell: str) -> list[str]:
    """Base/catalog cells: '3500B/35713' or a wrapped '35020 3500D' ->
    separate codes. These never contain internal spaces, so split on
    whitespace as well as slashes."""
    return [p for p in re.split(r"[\s/]+", cell) if p]


def split_boxsets(cell: str) -> list[str]:
    """Box Set / Force Pack cells can list several real products a mini
    ships in ('Legendary MechWarriors Pack or Salvage Box: Legendary',
    'Beginner Box<br/>A Game of Armored Combat' -> 'Beginner Box /
    A Game of Armored Combat' post-clean_cell). Split into separate names
    so each is a first-class, independently filterable pack rather than
    one joined blob."""
    if not cell:
        return []
    out = []
    for part in re.split(r"\s*/\s*", cell):
        part = re.sub(r"\s+or\s*$", "", part.strip())  # dangling "or" left by a <br>-turned-slash split
        for sub in re.split(r"\s+or\s+", part):
            sub = sub.strip()
            if sub:
                out.append(sub)
    return out


# ── Table parsing ────────────────────────────────────────────────────────────

def parse_tables(wikitext: str) -> list[dict]:
    entries = []
    section = ""
    lines = wikitext.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        m = re.match(r"^(={2,4})\s*(.*?)\s*\1$", line)
        if m:
            section = clean_cell(m.group(2))
            i += 1
            continue
        if line.startswith("{|"):
            i = parse_one_table(lines, i, section, entries)
            continue
        i += 1
    return entries


def parse_one_table(lines: list[str], start: int, section: str, entries: list[dict]) -> int:
    """Parse the table starting at lines[start] ('{|'); return the index
    just past its closing '|}'. Appends row dicts to entries."""
    cols: dict[str, int] = {}
    row_cells: list[str] = []
    header_cells: list[str] = []

    def cells_of(line: str, sep: str) -> list[str]:
        return [c for c in re.split(re.escape(sep), line)]

    def flush_header():
        nonlocal cols
        if not header_cells:
            return
        for idx, h in enumerate(header_cells):
            hl = clean_cell(h).lower()
            if "base" in hl and "base" not in [k for k in cols if k == "base"]:
                cols.setdefault("base", idx)
            elif "catalog" in hl:
                cols.setdefault("catalog", idx)
            elif "model" in hl:
                cols.setdefault("model", idx)
            elif hl == "name" or "name" in hl:
                cols.setdefault("name", idx)
            elif hl == "year":
                cols.setdefault("year", idx)
            elif "box" in hl or "set" in hl or "pack" in hl:
                cols.setdefault("boxset", idx)
        header_cells.clear()

    def flush_row():
        if not row_cells:
            return
        cells = [clean_cell(c) for c in row_cells]
        row_cells.clear()
        if not cols or "name" not in cols:
            return
        get = lambda key: cells[cols[key]] if key in cols and cols[key] < len(cells) else ""
        name = get("name")
        base, catalog, model, boxset, year = get("base"), get("catalog"), get("model"), get("boxset"), get("year")
        if not name or not (base or catalog):
            return
        entries.append({
            "name": name,
            "baseNumbers": split_codes(base),
            "catalogNumbers": split_codes(catalog),
            "models": split_multi(model),
            "boxSets": split_boxsets(boxset),
            "boxSet": boxset,  # legacy/display: original joined cell text
            "year": year,
            "section": section,
        })

    i = start + 1
    while i < len(lines):
        line = lines[i].strip()
        if line.startswith("|}"):
            flush_header()
            flush_row()
            return i + 1
        if line.startswith("{|"):        # nested table — skip it wholesale
            i = parse_one_table(lines, i, section, [])
            continue
        if line.startswith("|-"):
            flush_header()
            flush_row()
        elif line.startswith("!"):
            body = line[1:]
            header_cells.extend(cells_of(body, "!!") if "!!" in body else [body])
        elif line.startswith("|+"):
            pass                          # table caption
        elif line.startswith("|"):
            body = line[1:]
            row_cells.extend(cells_of(body, "||") if "||" in body else [body])
        elif row_cells:
            row_cells[-1] += " / " + line  # continuation of a multi-line cell
        i += 1
    flush_header()
    flush_row()
    return i


# ── Output ───────────────────────────────────────────────────────────────────

def derive_years(entries: list[dict]) -> tuple[dict, dict]:
    """pack name -> release year, and catalog number -> release year (for
    entries with no verified pack name), first-seen-wins per key. Real
    products consistently list one year per row across all their minis."""
    pack_years: dict[str, str] = {}
    catalog_years: dict[str, str] = {}
    for e in entries:
        year = e.get("year", "")
        if not year:
            continue
        for name in e.get("boxSets") or []:
            pack_years.setdefault(name, year)
        if not e.get("boxSets"):
            for cat in e.get("catalogNumbers", []):
                catalog_years.setdefault(cat, year)
    return pack_years, catalog_years


def write_outputs(entries: list[dict], out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    pack_years, catalog_years = derive_years(entries)
    doc = {
        "source": "https://www.sarna.net/wiki/Miniatures_-_Catalyst_Game_Labs",
        "attribution": "Data from Sarna BattleTechWiki (CC BY-NC-SA); miniatures by Catalyst Game Labs.",
        "fetched": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "entries": entries,
        "packYears": pack_years,
        "catalogYears": catalog_years,
    }
    (out_dir / "sarna-minis.json").write_text(json.dumps(doc, indent=1), encoding="utf-8")
    with (out_dir / "sarna-minis.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["Name", "Base Numbers", "Catalog Numbers", "Models", "Box Sets", "Year", "Section"])
        for e in entries:
            w.writerow([e["name"], " / ".join(e["baseNumbers"]), " / ".join(e["catalogNumbers"]),
                        " / ".join(e["models"]), " / ".join(e["boxSets"]), e["year"], e["section"]])
    print(f"Wrote {len(entries)} entries to {out_dir}/sarna-minis.json and .csv")


# ── Self-test ────────────────────────────────────────────────────────────────

SAMPLE_WIKITEXT = """
== Resculpts (2019-Present) ==
=== BattleTech Beginner Boxes and BattleTech: A Game of Armored Combat ===
Table Notes: blah.
{| class="wikitable"
! Image !! Base Number !! Catalog Number !! Model !! Name !! Parts !! Manufacturer !! Year !! Material !! Box Set
|-
| [[File:Griffin.jpg|75px]]
| 1
| 35020
| GRF-1N / -3N / C
| [[Griffin]]
| 1
| Catalyst Game Labs
| 2019
| Plastic
| Beginner Box
|-
| [[File:Wolverine.jpg|75px]] || 2 || 3500D || WVR-6R / -3R || [[Wolverine]] || 1 || Catalyst Game Labs || 2019 || Plastic || Beginner Box<br/>A Game of Armored Combat
|}

=== Mercenaries ===
{| class="wikitable"
! Image !! Base Number !! Catalog Number !! Model !! Name !! Parts !! Manufacturer !! Year !! Material !! Box Set
|-
| || 3-50 / 3-49 || 35759 || Standard / C || LRM Carrier || 12 || Liya International || 2024 || Plastic || Support Lance
|}

== Classics (2007-2014) ==
=== Classic BattleTech Introductory Box Set ===
{| class="wikitable"
! Image !! Catalog Number !! Model !! Name !! Parts !! Manufacturer !! Year !! Material
|-
| || 35000 || COM-2D || [[Commando]] || 1 || Catalyst Game Labs || 2007 || Plastic
|}
"""


def selftest() -> int:
    entries = parse_tables(SAMPLE_WIKITEXT)
    failures = []

    def check(cond, msg):
        if not cond:
            failures.append(msg)

    check(len(entries) == 4, f"expected 4 entries, got {len(entries)}: {[e['name'] for e in entries]}")
    by_name = {e["name"]: e for e in entries}
    g = by_name.get("Griffin", {})
    check(g.get("baseNumbers") == ["1"], f"Griffin base: {g.get('baseNumbers')}")
    check(g.get("models") == ["GRF-1N", "-3N", "C"], f"Griffin models: {g.get('models')}")
    check(g.get("boxSets") == ["Beginner Box"], f"Griffin boxSets: {g.get('boxSets')}")
    w = by_name.get("Wolverine", {})
    check(w.get("baseNumbers") == ["2"], f"Wolverine base: {w.get('baseNumbers')}")
    check(w.get("boxSets") == ["Beginner Box", "A Game of Armored Combat"],
          f"Wolverine boxSets (should be split, not joined): {w.get('boxSets')}")
    l = by_name.get("LRM Carrier", {})
    check(l.get("baseNumbers") == ["3-50", "3-49"], f"LRM Carrier bases: {l.get('baseNumbers')}")
    check(l.get("section") == "Mercenaries", f"LRM Carrier section: {l.get('section')}")
    c = by_name.get("Commando", {})
    check(c.get("baseNumbers") == [], f"Commando base (classics, none): {c.get('baseNumbers')}")
    check(c.get("catalogNumbers") == ["35000"], f"Commando catalog: {c.get('catalogNumbers')}")
    check(g.get("year") == "2019", f"Griffin year: {g.get('year')}")
    check(c.get("year") == "2007", f"Commando year (no Year column match ambiguity): {c.get('year')}")

    pack_years, catalog_years = derive_years(entries)
    check(pack_years.get("Beginner Box") == "2019", f"Beginner Box pack year: {pack_years.get('Beginner Box')}")
    check(pack_years.get("A Game of Armored Combat") == "2019",
          f"A Game of Armored Combat pack year: {pack_years.get('A Game of Armored Combat')}")
    check(catalog_years.get("35000") == "2007", f"Commando catalog-fallback year: {catalog_years.get('35000')}")

    if failures:
        print("SELFTEST FAILED:")
        for f in failures:
            print(" -", f)
        return 1
    print(f"SELFTEST OK — {len(entries)} entries parsed as expected")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out-dir", default="data", help="output directory (default: data/)")
    ap.add_argument("--selftest", action="store_true", help="validate the parser against embedded sample wikitext (no network)")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    print(f"Fetching wikitext for '{PAGE}' from Sarna…")
    wikitext = fetch_wikitext()
    entries = parse_tables(wikitext)
    if len(entries) < 50:
        print(f"WARNING: only {len(entries)} entries parsed — the page layout may have "
              "changed. Not writing outputs; inspect the wikitext and update the parser.",
              file=sys.stderr)
        return 1
    write_outputs(entries, Path(args.out_dir))
    return 0


if __name__ == "__main__":
    sys.exit(main())
