"""
merge_sheets.py — Merge BattleMech record-sheet PDFs into one file for printing.

Usage (double-click OR drag a list file onto it OR run from terminal):
    python merge_sheets.py                        # prompts for a list file
    python merge_sheets.py formation.txt          # reads the file directly
    python merge_sheets.py "C:\path\to\list.txt"

The list file is exported from the Lance Builder (Sheets → Export Unit List).
One unit name per line, blank lines and # comments are ignored.

Requires:  pip install pypdf
Output:    Desktop\battletech_formation.pdf  (opened automatically)
"""

import sys
import os
import subprocess
from pathlib import Path

# ── CONFIG ──────────────────────────────────────────────────────────────────
SHEETS_DIR  = Path(r"\\HouserNAS\HouserFileBackup\AIBattletechProjects\Mech Sheets\Extracted Files")
OUTPUT_FILE = Path.home() / "Desktop" / "battletech_formation.pdf"
# ────────────────────────────────────────────────────────────────────────────

def ensure_pypdf():
    try:
        from pypdf import PdfWriter, PdfReader
        return PdfWriter, PdfReader
    except ImportError:
        print("pypdf not found — installing…")
        subprocess.run([sys.executable, "-m", "pip", "install", "pypdf"], check=True)
        from pypdf import PdfWriter, PdfReader
        return PdfWriter, PdfReader


def find_pdf(name: str) -> Path | None:
    """Locate a unit's PDF in SHEETS_DIR, tolerating minor name differences."""
    candidates = [
        name,
        name.rsplit(" (", 1)[0].strip(),          # strip parenthetical: "Atlas AS7-D (Ares)" → "Atlas AS7-D"
        name.replace("/", "-"),                    # slash variants
        name.replace(":", "_"),
    ]
    for stem in candidates:
        p = SHEETS_DIR / f"{stem}.pdf"
        if p.exists():
            return p

    # Case-insensitive fallback (slower, but catches capitalisation mismatches)
    lower = name.lower()
    for pdf in SHEETS_DIR.glob("*.pdf"):
        if pdf.stem.lower() == lower:
            return pdf

    return None


def open_pdf(path: Path):
    """Open the merged PDF in the system default viewer."""
    if sys.platform == "win32":
        os.startfile(path)
    elif sys.platform == "darwin":
        subprocess.run(["open", str(path)])
    else:
        subprocess.run(["xdg-open", str(path)])


def main():
    sys.stdout.reconfigure(encoding="utf-8")

    # ── Resolve input file ───────────────────────────────────────────────────
    if len(sys.argv) >= 2:
        list_file = Path(sys.argv[1].strip().strip('"'))
    else:
        raw = input("Drag the exported list file here and press Enter: ").strip().strip('"')
        list_file = Path(raw)

    if not list_file.exists():
        print(f"\nERROR: file not found — {list_file}")
        input("Press Enter to exit.")
        sys.exit(1)

    # ── Parse unit names ─────────────────────────────────────────────────────
    names = [
        line.strip()
        for line in list_file.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]

    if not names:
        print("ERROR: list file is empty.")
        input("Press Enter to exit.")
        sys.exit(1)

    print(f"\nFound {len(names)} units — locating PDFs on NAS…\n")

    # ── Check NAS is reachable ────────────────────────────────────────────────
    if not SHEETS_DIR.exists():
        print(f"ERROR: Cannot reach NAS path:\n  {SHEETS_DIR}")
        print("Make sure you are on the home network and the NAS drive is mapped.")
        input("Press Enter to exit.")
        sys.exit(1)

    # ── Merge ────────────────────────────────────────────────────────────────
    PdfWriter, PdfReader = ensure_pypdf()

    writer  = PdfWriter()
    found   = 0
    missing = []

    for name in names:
        pdf_path = find_pdf(name)
        if pdf_path:
            try:
                reader = PdfReader(str(pdf_path))
                for page in reader.pages:
                    writer.add_page(page)
                found += 1
                print(f"  ✓  {name}")
            except Exception as e:
                missing.append(name)
                print(f"  ✗  {name}  (read error: {e})")
        else:
            missing.append(name)
            print(f"  ✗  {name}  (PDF not found)")

    if found == 0:
        print("\nNo sheets could be merged — nothing to save.")
        input("Press Enter to exit.")
        sys.exit(1)

    # ── Save & open ──────────────────────────────────────────────────────────
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_FILE, "wb") as f:
        writer.write(f)

    print(f"\n{'─'*50}")
    print(f"  Merged {found} sheet(s) → {OUTPUT_FILE}")
    if missing:
        print(f"  Skipped {len(missing)}: {', '.join(missing)}")
    print(f"{'─'*50}\n")
    print("Opening in your PDF viewer — print from there.\n")

    open_pdf(OUTPUT_FILE)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception as e:
        print(f"\nUnexpected error: {e}")
        input("Press Enter to exit.")
