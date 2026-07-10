# Record Sheets — State & Roadmap

_Last updated: July 2026 (PR #56)._

## Current state

Self-drawn Classic BattleTech record sheets render in every force flow
(Tournament builder, Lance Builder CSV/Search tabs, Owned Units) for
**biped mechs**. Sheets are static (fill in with a pencil); the only actions
are per-sheet **Print / Save PDF** and the full-force browser print, which
outputs one clean sheet per page.

**Layout** is a 1:1 port of jdgwf/battletech-tools' 2000×2600 page:

- 'Mech Data (movement dice, tonnage/tech/era, Cost + BV)
- Warrior Data — Gunnery = the unit's skill setting, Piloting = Gunnery + 1
- Weapons and Equipment with a per-weapon to-hit **Mod** column
  (pulse −2, MRM/RL +1, LB-X −1 conditional, Targeting Computer −1 on
  direct fire; Clan weapons use a separate Clan stats table)
- **Cluster Hits Table** + **To-Hit Modifiers** in a fixed strip (always
  rendered, so every sheet prints with identical geometry)
- Critical Hit Table with the reference's capsule styling
- Armor / Internal Structure silhouettes with centred damage bubbles,
  rear-torso diagram, Damage Transfer diagram
- Heat Effects, Sinks (centred dot grid), vertical 31-box Heat Scale

**Data**: `sheets/mech-data.json` — 4,113 mechs built from the MegaMek
`mm-data` MTF database (authoritative per-location crit slots incl. Endo
Steel/Ferro-Fibrous filler, rear armor, MUL ids) with BV/cost backfilled
from the SSW dataset where a variant exists there (~630 units). Units are
matched by **MUL id first**, then normalized name, then IS-name alias
("Thor Prime" → "Summoner Prime").

**Fallbacks**: quads / tripods / LAMs (in the data, no artwork yet) and
anything unmatched fall back to the scanned-PDF / mordel.net path.

## Rebuilding the data

```sh
# 1. MegaMek unit database (sparse clone, ~48MB of MTF files)
git clone --depth 1 --filter=blob:none --sparse https://github.com/MegaMek/mm-data.git
cd mm-data && git sparse-checkout set data/mekfiles/meks && cd ..

# 2. SSW snapshot (for BV/cost backfill)
curl -o sswMechs.ts https://raw.githubusercontent.com/jdgwf/battletech-tools/master/src/data/ssw/sswMechs.ts

# 3. Build
python3 build_sheet_data.py --src sswMechs.ts --mtf-dir mm-data/data/mekfiles/meks
```

## Roadmap (priority order)

### 1. Combat vehicle ("tank") sheets — DEFERRED, revisit next
The MegaMek database has **1,450 vehicles** as `.blk` files (easy to
parse: tagged blocks with armor per facing, weapons per location, motive
type). Needs a new sheet layout, not a mech-sheet variant:

- Armor diagram with Front / Left / Right / Rear (+ Turret) facings
- Motive damage table + vehicle critical-hits table (turret jam, weapon
  destroyed, crew stunned…) — fixed rules text, like Heat Effects
- Weapons table can reuse the mech table (Mod column, cluster table too)
- VTOLs add a Rotor facing; hovers/tracked/wheeled differ only in the
  motive-damage modifiers row
- Integration: extend `sheetMechData` matching to `BFType === 'CV'`
  records and route to a `rsVehicleSheetSVG`

### 2. Battle armor squad cards
1,188 `.blk` files. Per-squad sheet: 4–6 trooper rows with armor pips +
integrated weapons. Small, card-like layout — closer to the Alpha Strike
card work than the mech sheet.

### 3. Quad mech silhouettes
~160 quads/tripods are already in the data with leg locations mapped
(`fll/frl/rll/rrl`, crits included) — they only lack artwork. The
reference tool has `QuadArmorDiagramSVG` / `QuadRearArmorDiagramSVG` /
quad structure + circle placements to port, same technique as the biped
work (extract paths + circle coordinates into `rs-silhouettes.json`).

### 4. BV / cost for post-SSW units
MTF doesn't carry BV; ~3,500 newer units show "—". Options: scrape the
MUL unit pages (they list BV2), or accept the gap. PV already comes from
MUL at force-build time, so this is cosmetic.

### 5. Infantry / ProtoMechs / Aerospace
1,792 infantry platoons, 86 ProtoMechs, 502 fighters in `mm-data` —
each its own sheet format. Only worth doing if they show up in real
forces.

## Smaller polish backlog

- Era shown as a bare year; the reference prints era names
  ("Star League 2571–2780").
- Pilot name is a blank line on drawn sheets; could reuse the PDF path's
  pilot-name input.
- Superheavy mechs (>100t) are skipped (no structure-table rows).
- Artemis IV: cluster-roll +2 not surfaced (launcher fit isn't reliably
  detectable in the data).
- Heat-sink dot grid caps at 40 sinks.
