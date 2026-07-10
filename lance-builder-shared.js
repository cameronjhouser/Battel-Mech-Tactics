/**
 * lance-builder-shared.js
 * Faction data, the lance-formation engine, Alpha Strike card rendering,
 * and the self-drawn record-sheet engine — shared by index.html (Owned
 * Units + the embedded Skirmish tab) and skirmish-force-builder/index.html
 * (the standalone page). Expects the host page to provide the matching
 * DOM ids; functions guard on missing elements so it's safe to load on a
 * page that only has a subset of them.
 */

// Base URL for resolving sheets/ and sheets-popup.js — anchored to THIS
// script's own location (captured synchronously at load time via
// document.currentScript, which is only valid during initial execution),
// not the including page's URL. Both assets live at the repo root next to
// this file, but the pages that load it don't all live at the repo root
// (skirmish-force-builder/index.html is one directory deeper), so
// resolving against window.location.href would 404 there.
const LB_SHARED_BASE = (document.currentScript && document.currentScript.src) || window.location.href;

/* ══════════════════════════════════════════════════════
   LANCE BUILDER
══════════════════════════════════════════════════════ */
const MUL_API = 'https://masterunitlist.azurewebsites.net/Unit/QuickList';
const LB_SZ = ['','Light','Medium','Heavy','Assault'];
const LB_SZ_CLS = ['','sz1','sz2','sz3','sz4'];
document.addEventListener('DOMContentLoaded', () => {
  const foEl = document.getElementById('lb-owned-source-faction');
  if (foEl) foEl.outerHTML = lbFactionSelectHtml('lb-owned-source-faction', 'lbOwnedRender');
  sbMigrateCsvLists();
});

/* ── FORMATION ENGINE (shared by Owned Units + Skirmish Force Builder) ── */
let lbCurrentLances = []; // [[unit,...], ...] — live formation
let lbVariantsCache = {}; // chassis -> [unit,...]
let lbFormationDirty = false;
let lbLanceTypes    = []; // per-lance special type key
let lbDragSrc       = null; // {li, si}
let lbCmdState      = {}; // `${li}-${si}` -> ability string or ''

const LB_CMD_ABILITIES = [
  'Antagonizer', 'Blood Stalker', 'Combat Intuition',
  "Eagle's Eyes", 'Marksman', 'Multi-Tasker', '★ Tactical Genius',
];

const LB_ERAS = [
  { label: 'All Eras',                    min: 0,    max: 9999 },
  { label: 'Age of War (≤ 2570)',         min: 0,    max: 2570 },
  { label: 'Star League (2571–2780)',     min: 2571, max: 2780 },
  { label: 'Succession Wars (2781–3049)', min: 2781, max: 3049 },
  { label: 'Clan Invasion (3050–3061)',   min: 3050, max: 3061 },
  { label: 'Civil War (3062–3067)',       min: 3062, max: 3067 },
  { label: 'Jihad (3068–3080)',           min: 3068, max: 3080 },
  { label: 'Republic Era (3081–3130)',    min: 3081, max: 3130 },
  { label: 'Dark Age (3131–3150)',        min: 3131, max: 3150 },
  { label: 'ilClan (3151+)',             min: 3151, max: 9999 },
];

function lbParseEraVal(val) {
  if (!val) return null;
  const parts = val.split('-').map(Number);
  return parts.length === 2 ? { min: parts[0], max: parts[1] } : { min: 0, max: parts[0] };
}

// Lance-type abilities: lanceWide = whole lance gets all listed; perUnit = each unit picks one
const LB_TYPE_ABILITIES = {
  recon:        { lanceWide: ["Eagle's Eyes", 'Forward Observer', 'Maneuvering Ace'] },
  strike:       { lanceWide: ['Speed Demon'] },
  fire:         { lanceWide: ['Sniper'] },
  battle:       { lanceWide: ['Lucky'] },
  'assault-sp': { lanceWide: ['Demoralizer', 'Multi-Tasker'] },
  command:      { perUnit:   ['Antagonizer', 'Blood Stalker', 'Combat Intuition', "Eagle's Eyes", 'Marksman', 'Multi-Tasker', '★ Tactical Genius'] },
  pursuit:      { lanceWide: ['Blood Stalker'] },
};

const LB_ABILITY_DESC = {
  "Eagle's Eyes":     "Gains RCN keyword · +2\" sensor range · auto-reveal hidden ≤2\" · +2 minefield avoid",
  "Forward Observer": "Spot for indirect fire while attacking (no penalty) · multiple friendlies at once",
  "Maneuvering Ace":  "Reduced movement penalty through woods and rough terrain",
  "Speed Demon":      "+2\" movement per turn without raising TMM",
  "Sniper":           "Half range penalties: +1 at medium (not +2) · +2 at long (not +4)",
  "Lucky":            "Reroll one failed to-hit roll per game (extra uses in larger formations)",
  "Demoralizer":      "Once/turn: enemies ≤6\" roll 2d6; on 8− → half MV & TMM, penalty to hit this lance",
  "Multi-Tasker":     "Split damage across two different targets in one attack",
  "Antagonizer":      "Enemies ≤6\" roll 2d6; fail → must move toward you and can only shoot you",
  "Blood Stalker":    "Pick 1 enemy at game start: −1 to hit that target · +2 vs all others",
  "Combat Intuition": "Win initiative → move and shoot immediately (3-turn cooldown)",
  "Marksman":         "Trade half damage & MV for Through-Armor Critical chance on hit by 3+",
  "★ Tactical Genius":"Leader only — reroll initiative once every 2 turns",
};

let lbUnitBonuses = {}; // `${li}-${si}` -> chosen ability string

// Flat-multiplier skill table used by the organized-lance view (per-lance
// skill selector rendered by lbLanceStatsHtml, reached from Owned Units'
// "Send to Build Lance" or Skirmish's "Build Formation"; only 0-4 selectable
// there). NOT used by Skirmish's flat Tournament Force list before it's
// organized into lances — see sbAdjPV/sbSkillIncrement below for the correct
// per-unit-PV-bracket official table used there.
const LB_SKILL_MULT = { 0: 1.82, 1: 1.62, 2: 1.42, 3: 1.20, 4: 1.00 };
const SB_SKILL_LEVELS = [0, 1, 2, 3, 4, 5, 6, 7];

function lbGetAdjLancePV(li) {
  const skillEl = document.getElementById(`lb-skill-${li}`);
  const skill   = skillEl ? parseInt(skillEl.value) : 3;
  const mult    = LB_SKILL_MULT[skill] ?? 1.0;
  const rawPV   = (lbCurrentLances[li] || []).reduce((s, u) => s + (u.BFPointValue||0), 0);
  return Math.round(rawPV * mult);
}

function lbUpdateTotalPV() {
  const total  = lbCurrentLances.reduce((s, _, li) => s + lbGetAdjLancePV(li), 0);
  const supply = Math.ceil(total * 0.1);
  const tEl = document.getElementById('lb-total-pv');
  const sEl = document.getElementById('lb-total-sp');
  if (tEl) tEl.textContent = total;
  if (sEl) sEl.textContent = supply;
}

function lbSkillChanged(li) {
  const skillEl = document.getElementById(`lb-skill-${li}`);
  if (!skillEl) return;
  const skill  = parseInt(skillEl.value);
  const mult   = LB_SKILL_MULT[skill] ?? 1.0;
  const rawPV  = (lbCurrentLances[li] || []).reduce((s, u) => s + (u.BFPointValue||0), 0);
  const adjPV  = Math.round(rawPV * mult);
  const pvEl   = document.getElementById(`lb-lance-pv-${li}`);
  if (pvEl) pvEl.innerHTML = skill === 4
    ? `${rawPV} PV`
    : `${adjPV} PV <span style="font-size:9px;color:var(--text3)">×${mult.toFixed(2)}</span>`;
  lbUpdateTotalPV();
}

function lbGetLanceTaken(li, excludeSi) {
  const s = new Set();
  (lbCurrentLances[li] || []).forEach((_, si) => {
    if (si === excludeSi) return;
    const b = lbUnitBonuses[`${li}-${si}`];
    if (b) s.add(b);
  });
  return s;
}

function lbLanceQualifies(units, specKey) {
  if (!specKey || !units.length) return true;
  const spec = LB_SPECIAL_TYPES[specKey];
  if (!spec) return false;
  // — existing checks —
  if (spec.noSizes    && units.some(u => spec.noSizes.includes(u.BFSize||0)))                           return false;
  if (spec.needMV     && units.some(u => lbGetMV(u) < spec.needMV))                                     return false;
  if (spec.needMVorJ  && units.some(u => lbGetMV(u) < spec.needMVorJ && lbGetJump(u) < spec.needMVorJ)) return false;
  if (spec.minRoleCount && spec.roleCheck && units.filter(u => spec.roleCheck(u)).length < spec.minRoleCount) return false;
  if (spec.minRolePct   && spec.roleCheck && units.filter(u => spec.roleCheck(u)).length / units.length < spec.minRolePct) return false;
  if (spec.heavyAssaultPct && units.filter(u=>(u.BFSize||0)>=3).length / units.length < spec.heavyAssaultPct) return false;
  if (spec.heavyAssaultMin && units.filter(u=>(u.BFSize||0)>=3).length < spec.heavyAssaultMin) return false;
  // — faction-specific checks —
  if (spec.allSize !== undefined && units.some(u => (u.BFSize||0) !== spec.allSize)) return false;
  if (spec.sizePctRange) {
    const { sizes, pct } = spec.sizePctRange;
    if (units.filter(u => sizes.includes(u.BFSize||0)).length / units.length < pct) return false;
  }
  if (spec.maxDmgAny !== undefined && units.some(u =>
    (parseInt(u.BFDamageShort)||0)  > spec.maxDmgAny ||
    (parseInt(u.BFDamageMedium)||0) > spec.maxDmgAny ||
    (parseInt(u.BFDamageLong)||0)   > spec.maxDmgAny)) return false;
  if (spec.minUnits !== undefined && units.length < spec.minUnits) return false;
  if (spec.maxUnits !== undefined && units.length > spec.maxUnits) return false;
  if (spec.allInfantry && units.some(u => !['Battle Armor','Infantry'].includes(u.Type?.Name||''))) return false;
  return true;
}

function lbSetUnitBonus(li, si, ability) {
  lbUnitBonuses[`${li}-${si}`] = ability;
}

const LB_SPECIAL_TYPES = {
  recon:       { name:'Recon / Scout Lance',      noSizes:[],  needMV:10, roleCheck:u=>['Scout','Striker'].includes(u.Role?.Name),                         minRoleCount:2 },
  strike:      { name:'Strike / Striker Lance',   noSizes:[4], needMVorJ:10, roleCheck:u=>['Striker','Skirmisher'].includes(u.Role?.Name),                 minRolePct:.5  },
  fire:        { name:'Fire Lance',               noSizes:[],  roleCheck:u=>['Missile Boat','Sniper'].includes(u.Role?.Name),                              minRoleCount:3 },
  battle:      { name:'Battle / Line Lance',      noSizes:[],  roleCheck:u=>['Brawler','Sniper','Skirmisher'].includes(u.Role?.Name),                      minRoleCount:3, heavyAssaultPct:.5 },
  'assault-sp':{ name:'Assault Lance (Special)',  noSizes:[1], roleCheck:u=>true, heavyAssaultMin:3 },
  command:     { name:'Command Lance',            noSizes:[],  roleCheck:u=>['Missile Boat','Juggernaut','Skirmisher','Sniper'].includes(u.Role?.Name),     minRolePct:.5  },
  pursuit:     { name:'Pursuit Lance',            noSizes:[],  needMV:10, roleCheck:u=>['Striker','Skirmisher'].includes(u.Role?.Name),                    minRoleCount:2 },
};

// Returns merged standard + faction-specific type option objects for a given faction + unit mix
function lbGetFactionTypeOpts(factionId, units, curType) {
  const base = [
    { v:'',           t:'Standard'             },
    { v:'recon',      t:'Recon / Scout'         },
    { v:'strike',     t:'Strike / Striker'      },
    { v:'fire',       t:'Fire'                  },
    { v:'battle',     t:'Battle / Line'         },
    { v:'assault-sp', t:'Assault (Special)'     },
    { v:'command',    t:'Command'               },
    { v:'pursuit',    t:'Pursuit'               },
  ];
  const factionKeys = LB_FACTION_TYPES[String(factionId || '')] || [];
  factionKeys.forEach(k => {
    const spec = LB_SPECIAL_TYPES[k];
    if (spec) base.push({ v:k, t:spec.name, faction:true });
  });
  return base.map(opt => {
    if (!opt.v) return { ...opt, disabled:false };
    const qualifies = !units?.length || lbLanceQualifies(units, opt.v);
    return { ...opt, disabled:!qualifies };
  });
}

function lbGetMV(u) {
  const mv = (u.BFMove || '0').toString();
  const nums = mv.match(/\d+/g);
  return nums ? Math.max(...nums.map(Number)) : 0;
}
function lbGetJump(u) {
  const m = (u.BFMove || '').toString().match(/(\d+)j/i);
  return m ? parseInt(m[1]) : 0;
}
function lbGetChassis(name) {
  // Strip trailing variant code like "WHM-6R", "AS7-D" to get chassis name
  return name.replace(/\s+[A-Z]{1,5}[-\d][A-Z0-9-]*$/i, '').trim() || name.split(' ')[0];
}
function lbSpecialScore(u, specKey) {
  const spec = LB_SPECIAL_TYPES[specKey];
  if (!spec) return (u.BFSize||0)*100 + (u.BFPointValue||0);
  let score = 0;
  if (spec.noSizes && spec.noSizes.includes(u.BFSize||0)) score -= 5000;
  if (spec.needMV   && lbGetMV(u) < spec.needMV)          score -= 2000;
  if (spec.needMVorJ && lbGetMV(u) < spec.needMVorJ && lbGetJump(u) < spec.needMVorJ) score -= 2000;
  if (spec.roleCheck && spec.roleCheck(u)) score += 200;
  if ((specKey === 'battle' || specKey === 'assault-sp') && (u.BFSize||0) >= 3) score += 80;
  score += (u.BFPointValue||0) * 0.05;
  return score;
}

const LB_FORMATIONS = {
  'lance':       { name:'Lance',               lances:1,  unitsPerLance:4,  total:4  },
  'aug-lance':   { name:'Augmented Lance',      lances:1,  unitsPerLance:6,  total:6  },
  'demi':        { name:'Demi-Company',         lances:2,  unitsPerLance:3,  total:6  },
  'company':     { name:'Company',              lances:3,  unitsPerLance:4,  total:12 },
  'aug-company': { name:'Augmented Company',    lances:3,  unitsPerLance:4,  total:12 },
  'ctf':         { name:'Company Task Force',   lances:5,  unitsPerLance:4,  total:20 },
  'battalion':      { name:'Battalion',                lances:10,  unitsPerLance:4, total:40  },
  'air-lance':      { name:'Air Lance',                lances:2,   unitsPerLance:4, total:8   },
  'aug-battalion':  { name:'Augmented Battalion',      lances:14,  unitsPerLance:4, total:56  },
  'reinf-battalion':{ name:'Reinforced Battalion',     lances:12,  unitsPerLance:4, total:48  },
  'sl-battalion':   { name:'SL Reinforced Battalion',  lances:16,  unitsPerLance:4, total:64  },
  'regiment':       { name:'Regiment',                 lances:27,  unitsPerLance:4, total:108 },
  'reinf-regiment': { name:'Reinforced Regiment',      lances:48,  unitsPerLance:4, total:192 },
  'brigade':        { name:'Brigade',                  lances:81,  unitsPerLance:4, total:324 },
  'reinf-brigade':  { name:'Reinforced Brigade',       lances:108, unitsPerLance:4, total:432 },
  'prov-brigade':   { name:'Provisional Brigade',      lances:54,  unitsPerLance:4, total:216 },
  // ── Clan formations (Stars, 5 units each) ──────────────────────
  'clan-star':      { name:'Star',         lances:1,  unitsPerLance:5, total:5,   isClan:true },
  'clan-nova':      { name:'Nova',         lances:2,  unitsPerLance:5, total:10,  isClan:true },
  'clan-binary':    { name:'Binary',       lances:2,  unitsPerLance:5, total:10,  isClan:true },
  'clan-trinary':   { name:'Trinary',      lances:3,  unitsPerLance:5, total:15,  isClan:true },
  'clan-supernova': { name:'Supernova',    lances:4,  unitsPerLance:5, total:20,  isClan:true },
  'clan-cluster':   { name:'Cluster',      lances:15, unitsPerLance:5, total:75,  isClan:true },
  'clan-galaxy':    { name:'Galaxy',       lances:45, unitsPerLance:5, total:225, isClan:true },
};

// The formation-organizer (LB_FORMATIONS/LB_SPECIAL_TYPES + lbAssignToTypes and
// all the lance-block/drag-drop/command/ability rendering below) is shared by
// Owned Units' "Send to Build Lance" and the Skirmish Force Builder tab, which
// both build into the SAME lbCurrentLances/lbLanceTypes/lbCmdState/
// lbUnitBonuses state and Skirmish's formation-type/special-type/faction
// selects and output container.
function lbFTypeEl()    { return document.getElementById('sb-formation-type'); }
function lbSTypeEl()    { return document.getElementById('sb-special-type'); }
function lbFFactionEl() { return document.getElementById('sb-faction'); }
function lbFOutId()     { return 'sb-formation-out'; }
function lbFormationIsClan() {
  const fid = lbFFactionEl()?.value || '';
  return !!sbFactionMeta[fid]?.isClan;
}
function lbFormationFactionName() {
  const fid = lbFFactionEl()?.value || '';
  if (!fid) return 'selected faction';
  return sbFactionMeta[fid]?.name || 'selected faction';
}

/* ── FACTIONS ───────────────────────────────────────────────────── */
const LB_FACTIONS = [
  { id:'',   name:'Any / Generic',              group:'' },
  // Inner Sphere Houses
  { id:'29', name:'Federated Suns',             group:'Inner Sphere' },
  { id:'27', name:'Draconis Combine',           group:'Inner Sphere' },
  { id:'60', name:'Lyran Commonwealth',         group:'Inner Sphere' },
  { id:'32', name:'Lyran Alliance',             group:'Inner Sphere' },
  { id:'30', name:'Free Worlds League',         group:'Inner Sphere' },
  { id:'5',  name:'Capellan Confederation',     group:'Inner Sphere' },
  { id:'18', name:'ComStar',                    group:'Inner Sphere' },
  { id:'48', name:'Word of Blake',              group:'Inner Sphere' },
  { id:'55', name:'Inner Sphere General',       group:'Inner Sphere' },
  { id:'28', name:'Free Rasalhague Republic',   group:'Inner Sphere' },
  { id:'41', name:'Republic of the Sphere',     group:'Inner Sphere' },
  { id:'46', name:'Second Star League',         group:'Inner Sphere' },
  // Star League era
  { id:'45', name:'Star League (Regular)',      group:'Star League' },
  { id:'43', name:'Star League (Royal)',        group:'Star League' },
  // Periphery
  { id:'33', name:'Magistracy of Canopus',      group:'Periphery' },
  { id:'47', name:'Taurian Concordat',          group:'Periphery' },
  { id:'36', name:'Outworlds Alliance',         group:'Periphery' },
  { id:'57', name:'Periphery General',          group:'Periphery' },
  // Clans
  { id:'24', name:'Clan Wolf',                  group:'Clans', isClan:true },
  { id:'15', name:'Clan Jade Falcon',           group:'Clans', isClan:true },
  { id:'11', name:'Clan Ghost Bear',            group:'Clans', isClan:true },
  { id:'20', name:'Clan Smoke Jaguar',          group:'Clans', isClan:true },
  { id:'17', name:'Clan Nova Cat',              group:'Clans', isClan:true },
  { id:'8',  name:'Clan Diamond Shark',         group:'Clans', isClan:true },
  { id:'40', name:'Rasalhague Dominion',        group:'Clans' },
  { id:'56', name:'IS Clan General',            group:'Clans' },
  // Mercenaries / Independents
  { id:'31', name:'Kell Hounds',                group:'Mercenaries' },
  { id:'49', name:"Wolf's Dragoons",            group:'Mercenaries' },
];

// Faction-specific special type keys, keyed by faction MUL ID string
const LB_FACTION_TYPES = {
  '29': ['davion-lightfire','davion-rifle','davion-hunter'],
  '27': ['kurita-horde','kurita-berserker','kurita-antimech'],
};

// Merge faction-specific types into LB_SPECIAL_TYPES
Object.assign(LB_SPECIAL_TYPES, {
  // ── Federated Suns ───────────────────────────────────────────────
  'davion-lightfire': {
    name:'Light Fire Lance (Davion)',
    noSizes:[3,4],
    roleCheck: u => ['Missile Boat','Sniper'].includes(u.Role?.Name),
    minRolePct: 0.5,
  },
  'davion-rifle': {
    name:'Rifle Lance (Davion)',
    noSizes:[1,4],
    needMV: 8,
    sizePctRange: { sizes:[2,3], pct:0.75 }, // 75% Size 2–3
    // ≥50% with AC weapons — checked manually (not exposed in AS data)
  },
  'davion-hunter': {
    name:'Hunter Lance (Davion)',
    roleCheck: u => ['Ambusher','Juggernaut'].includes(u.Role?.Name),
    minRolePct: 0.5,
  },
  // ── Draconis Combine ─────────────────────────────────────────────
  'kurita-horde': {
    name:'Horde Lance (Kurita)',
    allSize: 1,       // all units must be Size 1
    minUnits: 5,      // 5–10 units
    maxUnits: 10,
    maxDmgAny: 2,     // no weapon >2 damage at any range
  },
  'kurita-berserker': {
    name:'Berserker Lance (Kurita)',
    heavyAssaultPct: 0.5, // ≥50% Size 3+
    roleCheck: u => ['Brawler','Sniper','Skirmisher'].includes(u.Role?.Name),
    minRoleCount: 3,
  },
  'kurita-antimech': {
    name:"Anti-'Mech Lance (Kurita)",
    allInfantry: true, // all units must be Battle Armor or Infantry
  },
});

// Merge faction-specific abilities into LB_TYPE_ABILITIES
Object.assign(LB_TYPE_ABILITIES, {
  'davion-lightfire': { lanceWide: ['Coordinated Fire Support'] },
  'davion-rifle':     { perUnit:   ['Weapon Specialist','Sandblaster'] },
  'davion-hunter':    { lanceWide: ['Combat Intuition'] },
  'kurita-horde':     { lanceWide: ['Swarm'] },
  'kurita-berserker': { perUnit:   ['Two-Hander','Swordsman'] },
  'kurita-antimech':  { lanceWide: ['Anti-Mech Specialization'] },
});

// Merge faction ability descriptions into LB_ABILITY_DESC
Object.assign(LB_ABILITY_DESC, {
  'Coordinated Fire Support': 'Each unit picks a separate target; indirect fire vs. designated targets ignores range penalties.',
  'Weapon Specialist':  'Each pilot picks one weapon type. +1 damage with that weapon each activation.',
  'Sandblaster':        'Primary weapon hits reduce target armour by 1 additional point per attack.',
  'Swarm':              'Once per round: redirect one incoming attack to another friendly unit at same or closer range.',
  'Two-Hander':         'Physical attacks: roll twice, keep the higher result.',
  'Swordsman':          'Physical attacks deal +1 damage.',
  'Anti-Mech Specialization': 'Enemy units in base contact suffer +1 to-hit on all attacks vs. this lance.',
});

function lbFactionSelectHtml(selId, onchangeFn) {
  let html = `<select id="${selId}"${onchangeFn?' onchange="'+onchangeFn+'()"':''} title="Filter units by faction availability">`;
  html += `<option value="">Any Faction</option>`;
  let lastGroup = '';
  LB_FACTIONS.filter(f => f.id).forEach(f => {
    if (f.group !== lastGroup) {
      if (lastGroup) html += `</optgroup>`;
      html += `<optgroup label="${f.group}">`;
      lastGroup = f.group;
    }
    html += `<option value="${f.id}">${f.name}</option>`;
  });
  if (lastGroup) html += `</optgroup>`;
  html += `</select>`;
  return html;
}

// Returns true if the given MUL faction ID string maps to a Clan faction
function lbIsClanFaction(factionId) {
  const f = LB_FACTIONS.find(f => f.id === String(factionId || ''));
  return f?.isClan === true;
}

// Returns "Star N" for Clan factions, "Lance N" for IS
function lbGroupLabel(isClan, li) {
  return isClan ? `Star ${li + 1}` : `Lance ${li + 1}`;
}

// Returns "star(s)" or "lance(s)" depending on faction
function lbGroupWord(isClan, count) {
  return (isClan ? 'star' : 'lance') + (count !== 1 ? 's' : '');
}

// Rebuilds the Skirmish tab's formation-type dropdown to show IS or Clan options.
function lbBuildFormationDropdowns(isClan) {
  const CLAN_OPTS = [
    ['clan-star',      'Star (5 units · 1 star)'],
    ['clan-nova',      'Nova (10 units · 2 stars — Mech + Elemental)'],
    ['clan-binary',    'Binary (10 units · 2 stars)'],
    ['clan-trinary',   'Trinary (15 units · 3 stars)'],
    ['clan-supernova', 'Supernova (20 units · 4 stars)'],
    ['clan-cluster',   'Cluster (75 units · 15 stars)'],
    ['clan-galaxy',    'Galaxy (225 units · 45 stars)'],
  ];
  const IS_OPTS = [
    ['lance',            'Lance (4 units · 1 lance)'],
    ['aug-lance',        'Augmented Lance (6 units · 1 lance + support)'],
    ['demi',             'Demi-Company (6 units · 1–2 lances)'],
    ['company',          'Company (12 units · 3 lances)'],
    ['aug-company',      'Augmented Company (12 units · 3 lances)'],
    ['ctf',              'Company Task Force (18–24 units · 4–6 lances)'],
    ['battalion',        'Battalion (40 units · 10 lances)'],
    ['air-lance',        'Air Lance (8 units · 2 lances)'],
    ['aug-battalion',    'Augmented Battalion (56 units · 14 lances)'],
    ['reinf-battalion',  'Reinforced Battalion (48 units · 12 lances)'],
    ['sl-battalion',     'SL Reinforced Battalion (64 units · 16 lances)'],
    ['regiment',         'Regiment (108 units · 27 lances)'],
    ['reinf-regiment',   'Reinforced Regiment (192 units · 48 lances)'],
    ['brigade',          'Brigade (324 units · 81 lances)'],
    ['reinf-brigade',    'Reinforced Brigade (432 units · 108 lances)'],
    ['prov-brigade',     'Provisional Brigade (216 units · 54 lances)'],
  ];
  const kOpts = (isClan ? CLAN_OPTS : IS_OPTS).map(([v,t]) => `<option value="${v}">${t}</option>`).join('');
  const kfEl = document.getElementById('sb-formation-type');
  if (kfEl) kfEl.innerHTML = kOpts;
}

function lbSwitchMode(mode) {
  document.getElementById('lb-mode-owned').style.display    = mode === 'owned'    ? '' : 'none';
  document.getElementById('lb-mode-skirmish').style.display = mode === 'skirmish' ? '' : 'none';
  document.getElementById('lb-tab-owned').classList.toggle('on', mode === 'owned');
  document.getElementById('lb-tab-skirmish').classList.toggle('on', mode === 'skirmish');
  if (mode === 'skirmish') { sbInit(); sbRefreshSavedSelect(); sbRefreshCollectionSelect(); }
}

/* ── SKIRMISH FORCE BUILDER ─────────────────────────── */
let sbCollection = {};   // normalized name -> true (from uploaded CSV)
const SB_COLLECTION_STORAGE_KEY = 'bmtSavedCollections.v1';
let sbCatalog    = [];   // all MUL units for current faction/era
let sbForce      = [];   // array of { unit, skill }
let sbLanceSpecs = [];   // per-lance-group index -> chosen specialty key ('' = Standard)
let sbUnitBonuses = {};  // sbForce index -> chosen per-unit ability string (Command Lance etc.)
let sbDragSrc    = null; // sbForce index currently being dragged
let sbInited     = false;
let sbSortKey    = 'BFPointValue';
let sbSortDir    = 1;    // 1=asc, -1=desc
let sbActiveType = 'all'; // selected unit-type tab ('all' or a Type.Name)
let sbAbilSel    = new Set(); // selected base ability codes (multi-select)
let sbAbilMode   = 'all';  // 'all' = unit must have every selected ability; 'any' = at least one
let sbAbilOpts   = [];     // [{code, n}] distinct base abilities in the catalog
let sbFactionMeta = {};    // faction id -> { name, isClan } (curated + live-loaded)
let sbFactionsLive = false;// true once the full list is loaded from MUL
const SB_SAVED_STORAGE_KEY = 'bmtSavedLances.v1';
let sbLastAutoIntro = null; // last auto-filled Introduced Year MAX value, or null

// Verified active-year windows for factions with a well-documented, stable
// historical end date (mostly extinct/absorbed Homeworld Clans). Keyed by
// exact faction name so it works regardless of MUL's numeric id. Deliberately
// small: major Houses persist across the whole timeline with no single
// "end year", and most Clans don't have a clean, uncontested end date, so
// they're intentionally left out rather than guessed. All 20 original Clans
// were founded in 2807 (Exodus).
const SB_FACTION_ACTIVE_YEARS = {
  'Clan Wolverine':    { start: 2807, end: 2823 }, // Annihilated — confirmed against MUL's own faction page
  'Clan Widowmaker':   { start: 2807, end: 2834 }, // Absorbed by Clan Wolf
  'Clan Mongoose':     { start: 2807, end: 2868 }, // Absorbed by Clan Smoke Jaguar
  'Clan Burrock':      { start: 2807, end: 3059 }, // Absorbed by Clan Star Adder (brief 3074 revival not modeled)
  'Clan Smoke Jaguar': { start: 2807, end: 3060 }, // Trial of Annihilation, Operations Bulldog/Serpent
};

const SB_ERA_LABELS = {
  '16':'Dark Age','257':'ilClan','254':'Late Republic','15':'Early Republic',
  '14':'Jihad','247':'Civil War','13':'Clan Invasion','256':'Late SW – Renaissance',
  '255':'Late SW – LosTech','11':'Early Succession War','10':'Star League',
};

function sbNorm(name) {
  return String(name || '').toLowerCase()
    .replace(/\s*\([^)]*\)/g, '')   // strip "(Ice Ferret T)" parentheticals
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ').trim();
}

function sbIsOwned(unit) {
  if (!Object.keys(sbCollection).length) return false;
  const mn = sbNorm(unit.Name);
  return Object.keys(sbCollection).some(c => mn === c || mn.includes(c) || c.includes(mn));
}

function sbIsJump(unit) {
  return /\bJMPS\d*\b|\bJMPW\d*\b/i.test(unit.BFAbilities || '');
}

// Unit-type grouping for the catalog table
const SB_TYPE_ORDER = ['BattleMech','ProtoMech','Combat Vehicle','Support Vehicle','Battle Armor','Infantry','Aerospace Fighter','Conventional Fighter'];
const SB_TYPE_PLURAL = {
  'BattleMech':'BattleMechs', 'ProtoMech':'ProtoMechs', 'Combat Vehicle':'Combat Vehicles',
  'Support Vehicle':'Support Vehicles', 'Battle Armor':'Battle Armor', 'Infantry':'Infantry',
  'Aerospace Fighter':'Aerospace Fighters', 'Conventional Fighter':'Conventional Fighters'
};
function sbTypeLabel(t) { return SB_TYPE_PLURAL[t] || t || 'Other'; }

// ── Abilities multi-select ─────────────────────────────────────────
// Split a BFAbilities string into individual tokens.
function sbAbilTokens(u) {
  return String(u.BFAbilities || '').split(',').map(s => s.trim()).filter(Boolean);
}
// Reduce a token to its base ability code: "JMPS2"→"JMPS", "IF1"→"IF",
// "LRM1/2/2"→"LRM", "HT2"→"HT"; C3 family kept intact ("C3", "C3I", "C3BSM").
function sbAbilBase(tok) {
  const t = String(tok || '').trim();
  if (!t) return '';
  if (/^C3/i.test(t)) return t.replace(/\/.*$/, '').toUpperCase();
  const m = t.match(/^[A-Za-z]+/);
  return (m ? m[0] : t).toUpperCase();
}
// Set of base ability codes a unit has.
function sbUnitAbilBases(u) {
  return new Set(sbAbilTokens(u).map(sbAbilBase).filter(Boolean));
}
// Build the distinct base-ability option list (with counts) from the catalog.
function sbBuildAbilOptions() {
  const counts = {};
  sbCatalog.forEach(u => sbUnitAbilBases(u).forEach(c => { counts[c] = (counts[c] || 0) + 1; }));
  sbAbilOpts = Object.keys(counts).sort().map(code => ({ code, n: counts[code] }));
  // Drop selections no longer present in this catalog
  sbAbilSel.forEach(c => { if (!(c in counts)) sbAbilSel.delete(c); });
}
function sbToggleAbilMenu(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById('sb-abil-menu');
  if (!menu) return;
  const open = menu.style.display !== 'none';
  if (open) { menu.style.display = 'none'; return; }
  menu.style.display = 'block';
  const s = document.getElementById('sb-abil-search');
  if (s) { s.value = ''; }
  sbRenderAbilMenu();
  if (s) s.focus();
}
function sbCloseAbilMenu() {
  const menu = document.getElementById('sb-abil-menu');
  if (menu) menu.style.display = 'none';
}
function sbRenderAbilMenu() {
  const list = document.getElementById('sb-abil-list');
  if (!list) return;
  const q = (document.getElementById('sb-abil-search')?.value || '').toUpperCase().trim();
  const opts = sbAbilOpts.filter(o => !q || o.code.includes(q));
  list.innerHTML = opts.length
    ? opts.map(o => `<label class="sb-abil-opt">
        <input type="checkbox" ${sbAbilSel.has(o.code) ? 'checked' : ''} onchange="sbToggleAbil('${o.code.replace(/'/g,"\\'")}')">
        <span>${lbEsc(o.code)}</span><span class="sb-abil-n">${o.n}</span>
      </label>`).join('')
    : `<div style="font-size:10px;color:var(--text3);padding:6px;text-align:center">No abilities${sbCatalog.length ? ' match' : ' — load a catalog first'}</div>`;
  const cnt = document.getElementById('sb-abil-selcount');
  if (cnt) cnt.textContent = `${sbAbilSel.size} selected`;
}
function sbToggleAbil(code) {
  if (sbAbilSel.has(code)) sbAbilSel.delete(code); else sbAbilSel.add(code);
  sbUpdateAbilBtn();
  sbRenderBrowse();
}
function sbToggleAbilMode(e) {
  if (e) e.stopPropagation();
  sbAbilMode = sbAbilMode === 'all' ? 'any' : 'all';
  const el = document.getElementById('sb-abil-mode');
  if (el) el.textContent = sbAbilMode === 'all' ? 'match ALL' : 'match ANY';
  if (sbAbilSel.size) sbRenderBrowse();
}
function sbClearAbil() {
  sbAbilSel.clear();
  sbUpdateAbilBtn();
  sbRenderAbilMenu();
  sbRenderBrowse();
}
function sbUpdateAbilBtn() {
  const btn = document.getElementById('sb-abil-btn');
  if (!btn) return;
  const n = sbAbilSel.size;
  btn.textContent = n === 0 ? 'Any ability ▾'
    : n <= 3 ? [...sbAbilSel].join(', ') + ' ▾'
    : `${n} abilities ▾`;
  const cnt = document.getElementById('sb-abil-selcount');
  if (cnt) cnt.textContent = `${n} selected`;
}

// Parse leading integer from a Move value ("8\"", "10j", "6\"/8\"j" → 8/10/6)
function sbMoveNum(unit) {
  const m = String(unit.BFMove ?? '').match(/\d+/);
  return m ? parseInt(m[0]) : 0;
}

// Parse a damage value that may carry markers ("1", "0*", "2*" → numeric part)
function sbDmgNum(v) {
  const m = String(v ?? '').match(/\d+/);
  return m ? parseInt(m[0]) : 0;
}

// Parse the introduction year from DateIntroduced ("3025", "3025-Refit" → 3025)
function sbIntroYear(unit) {
  const m = String(unit.DateIntroduced ?? '').match(/\d{3,4}/);
  return m ? parseInt(m[0]) : 0;
}

function sbClearFilters() {
  ['sb-filter-name','sb-filter-move-min','sb-filter-move-max',
   'sb-filter-pv-min','sb-filter-pv-max','sb-filter-dmg-s','sb-filter-dmg-m','sb-filter-dmg-l',
   'sb-filter-intro-min','sb-filter-intro-max']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  ['sb-filter-role','sb-filter-size-min','sb-filter-size-max']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const oo = document.getElementById('sb-owned-only'); if (oo) oo.checked = false;
  const sr = document.getElementById('sb-standard-rules-only'); if (sr) sr.checked = false;
  sbAbilSel.clear();
  sbUpdateAbilBtn();
  sbRenderAbilMenu();
  sbRenderBrowse();
}

function sbHtVal(unit) {
  const m = (unit.BFAbilities || '').match(/\bHT(\d+)\b/i);
  return m ? parseInt(m[1]) : 0;
}

// Official "Improved-Skill PV Increase Table" (Alpha Strike errata) — the
// per-skill-step PV delta depends on the UNIT'S OWN base PV bracket, not a
// flat multiplier. Verified exactly against the official table:
//   Base PV 0-7 -> 1, 8-12 -> 2, 13-17 -> 3, 18-22 -> 4, 23-27 -> 5,
//   28-32 -> 6, 33-37 -> 7, 38-42 -> 8, 43-47 -> 9, 48-52 -> 10,
//   +1 more for every 5 base PV over 52 (53-57 -> 11, 58-62 -> 12, ...).
function sbSkillIncrement(basePV) {
  if (basePV <= 7) return 1;
  return 2 + Math.floor((basePV - 8) / 5);
}

// Skill 4 is baseline (no change). Skills 0-3 (better than baseline) ADD
// sbSkillIncrement(basePV) per step below 4 — this direction is the
// verified official table. Skills 5-7 (worse than baseline) SUBTRACT the
// same per-step amount, applied symmetrically as a working assumption —
// this direction is NOT independently confirmed; the official table found
// is titled specifically for skill IMPROVEMENT. Confirm against the
// Alpha Strike Companion / rulebook if you have the reduction-side table.
function sbAdjPV(unit, skill) {
  const basePV = unit.BFPointValue || 0;
  const steps  = 4 - skill;
  return Math.max(0, Math.round(basePV + steps * sbSkillIncrement(basePV)));
}

function sbInit() {
  if (sbInited) return;
  sbInited = true;
  const sel = document.getElementById('sb-faction');
  if (!sel) return;
  // Seed the curated list immediately (fallback + instant render), then try
  // to replace it with the complete list loaded live from the MUL.
  LB_FACTIONS.filter(f => f.id).forEach(f => {
    sbFactionMeta[f.id] = { name: f.name, isClan: !!f.isClan };
  });
  sbPopulateFactions(LB_FACTIONS.filter(f => f.id).map(f => ({ value: f.id, label: f.name })));
  sbLoadFactions();
  // Populate the formation-type dropdown up front — it otherwise only
  // refreshes on the faction select's onchange, which never fires if the
  // tab is opened with a faction already selected (e.g. a loaded saved
  // force) and left untouched, leaving it permanently empty.
  lbBuildFormationDropdowns(!!sbFactionMeta[sel.value]?.isClan);
  // Close the abilities multi-select when clicking outside it
  document.addEventListener('click', (e) => {
    const grp = document.getElementById('sb-abil-menu')?.parentElement;
    if (grp && !grp.contains(e.target)) sbCloseAbilMenu();
  });
  sbRenderForce();
}

// Derive the MUL origin from the QuickList URL
function sbMulBase() {
  try { return new URL(MUL_API).origin; } catch { return 'https://masterunitlist.azurewebsites.net'; }
}

// Populate the two faction controls from a flat {value,label} entry list:
//   #sb-faction          — specific factions, split into "Clans" vs everyone else
//   #sb-faction-general  — broader faction groups ("…General"), its own filter
// mirroring the reference tool's separate specific=/general= URL params.
function sbPopulateFactions(entries) {
  const sel = document.getElementById('sb-faction');
  const genSel = document.getElementById('sb-faction-general');
  if (!sel || !genSel) return;
  const prevF = sel.value, prevG = genSel.value;

  const isGeneral = (label) => String(label).toLowerCase().trim().endsWith('general');
  const isClanOf  = (e) => sbFactionMeta[String(e.value)]?.isClan ?? /\bclan\b/i.test(e.label);

  const specific = entries.filter(e => !isGeneral(e.label));
  const generals = entries.filter(e => isGeneral(e.label)).sort((a, b) => a.label.localeCompare(b.label));
  const clanFacs  = specific.filter(isClanOf).sort((a, b) => a.label.localeCompare(b.label));
  const otherFacs = specific.filter(e => !isClanOf(e)).sort((a, b) => a.label.localeCompare(b.label));

  sel.innerHTML = '';
  sel.appendChild(Object.assign(document.createElement('option'), { value: '', textContent: 'Select faction…' }));
  const addGroup = (label, arr) => {
    if (!arr.length) return;
    const og = document.createElement('optgroup');
    og.label = label;
    arr.forEach(e => og.appendChild(Object.assign(document.createElement('option'), { value: String(e.value), textContent: e.label })));
    sel.appendChild(og);
  };
  addGroup('Inner Sphere / Periphery / Mercenary', otherFacs);
  addGroup('Clans', clanFacs);
  if (prevF) sel.value = prevF;

  genSel.innerHTML = '';
  genSel.appendChild(Object.assign(document.createElement('option'), { value: '', textContent: 'None (use faction above)' }));
  generals.forEach(e => genSel.appendChild(Object.assign(document.createElement('option'), { value: String(e.value), textContent: e.label })));
  if (prevG) genSel.value = prevG;
}

// Faction and General are mutually exclusive — picking one clears the other.
function sbFactionChanged() {
  sbApplyFactionYearPreset();
  sbClearCatalog();
  sbRenderForce();
  const isClan = !!sbFactionMeta[document.getElementById('sb-faction')?.value]?.isClan;
  lbBuildFormationDropdowns(isClan);
}

// Auto-suggests the Introduced Year range for factions with a verified
// active-year window (SB_FACTION_ACTIVE_YEARS). Never overwrites a value
// the user typed themselves — only fills empty fields, or fields that
// still hold whatever this function last auto-filled. Clears the fields
// back out (same rule) when switching to a faction with no known window.
function sbApplyFactionYearPreset() {
  const sel = document.getElementById('sb-faction');
  const maxEl = document.getElementById('sb-filter-intro-max');
  if (!sel || !maxEl) return;

  const name = sbFactionMeta[sel.value]?.name || '';
  const preset = SB_FACTION_ACTIVE_YEARS[name];
  const status = document.getElementById('sb-status');

  const untouched = (el, val) => !el.value || (sbLastAutoIntro != null && String(val) === el.value);

  if (preset) {
    if (untouched(maxEl, sbLastAutoIntro)) maxEl.value = preset.end;
    sbLastAutoIntro = preset.end;
    if (status) status.textContent = `Auto-filled Introduced Year max to ${lbEsc(name)}'s known dissolution year (${preset.end}) — edit or clear if needed, then Load Catalog.`;
  } else if (sbLastAutoIntro != null) {
    if (maxEl.value === String(sbLastAutoIntro)) maxEl.value = '';
    sbLastAutoIntro = null;
  }
}
function sbGeneralChanged() {
  sbClearCatalog();
  sbRenderForce();
}

// The effective faction id currently in play, whichever control holds it.
function sbCurrentFactionId() {
  return document.getElementById('sb-faction')?.value || document.getElementById('sb-faction-general')?.value || '';
}

// Both Faction and General are sent to MUL together as separate Factions=
// values when both are set (this is how the reference tool combines them —
// they are complementary filters, not alternatives).
function sbCurrentFactionIds() {
  const specific = document.getElementById('sb-faction')?.value || '';
  const general  = document.getElementById('sb-faction-general')?.value || '';
  return [...new Set([specific, general].filter(Boolean))];
}

// MUL's QuickList endpoint silently truncates results when no Types filter
// is given. Work around it by querying once per unit type and merging.
// Full Types id table (verified against MUL's own per-faction/era tab
// counts): Mech 18, Combat Vee 19, Aerospace 17, Infantry 21,
// Industrial Mech 20, ProtoMech 23, Support Vee 24, Adv Aerospace 81,
// Adv Support 79. (Building 97 / Unknown 76 excluded — not fieldable
// combat units.)
const SB_MUL_TYPE_IDS = [17, 18, 19, 20, 21, 23, 24, 79, 81];

// Load the complete faction list from the MUL Autocomplete endpoint.
// Falls back silently to the curated list already in the dropdown on failure.
async function sbLoadFactions() {
  try {
    const res = await fetch(`${sbMulBase()}/Faction/Autocomplete?term=`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) throw new Error('empty response');
    const entries = data
      .filter(f => f && f.label != null && f.value != null)
      .map(f => ({ value: f.value, label: String(f.label) }));
    if (!entries.length) throw new Error('no usable entries');
    // Merge into the meta map (curated isClan flags win; else infer from label)
    entries.forEach(e => {
      const id = String(e.value);
      const curated = sbFactionMeta[id];
      sbFactionMeta[id] = { name: e.label, isClan: curated?.isClan ?? /\bclan\b/i.test(e.label) };
    });
    sbPopulateFactions(entries);
    sbFactionsLive = true;
  } catch (e) {
    console.log('Faction live-load failed, keeping curated list:', e.message);
  }
}

function sbLoadCSV(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    sbCollection = {};
    const lines = e.target.result.split('\n');
    // Detect if first line is a header (Name, Variant, …)
    const firstLow = lines[0].toLowerCase();
    const start = firstLow.includes('name') ? 1 : 0;
    lines.slice(start).forEach(line => {
      const parts = line.split(',');
      const name = (parts[0] || '').trim().replace(/^"|"$/g,'');
      const variant = (parts[1] || '').trim().replace(/^"|"$/g,'');
      if (!name) return;
      sbCollection[sbNorm(name)] = true;
      if (variant) sbCollection[sbNorm(name + ' ' + variant)] = true;
    });
    const n = Object.keys(sbCollection).length;
    document.getElementById('sb-status').textContent =
      `Collection loaded: ${n} unit names from ${file.name}. Click Load Catalog to browse.`;
    sbRenderBrowse();
  };
  reader.readAsText(file);
}

// Saved collections persist the already-normalized sbCollection map (no MUL
// lookups involved for this one), so loading is instant — same
// save/pick-from-dropdown pattern as the Skirmish saved lances and CSV
// Formation Builder saved lists.
function sbStoredCollections() {
  try {
    return JSON.parse(localStorage.getItem(SB_COLLECTION_STORAGE_KEY) || '{}');
  } catch (_) {
    return {};
  }
}

function sbSetStoredCollections(collections) {
  localStorage.setItem(SB_COLLECTION_STORAGE_KEY, JSON.stringify(collections));
}

function sbSaveCollectionPrompt() {
  const n = Object.keys(sbCollection).length;
  if (!n) { alert('Upload a Collection CSV before saving a list.'); return; }
  const defaultName = localStorage.getItem('bmtSavedCollections.lastName') || '';
  const name = prompt('Save list as:', defaultName);
  if (!name) return;
  const key = name.trim();
  if (!key) return;
  const collections = sbStoredCollections();
  collections[key] = {
    name: key,
    updatedAt: new Date().toISOString(),
    unitCount: n,
    collection: sbCollection,
  };
  sbSetStoredCollections(collections);
  localStorage.setItem('bmtSavedCollections.lastName', key);
  sbRefreshCollectionSelect(key);
  alert(`Saved "${key}" with ${n} unit names.`);
}

function sbRefreshCollectionSelect(selectName) {
  const el = document.getElementById('sb-collection-select');
  if (!el) return;
  const collections = sbStoredCollections();
  const names = Object.keys(collections).sort((a, b) => a.localeCompare(b));
  const want = selectName ?? el.value;
  el.innerHTML = names.length
    ? names.map(n => `<option value="${lbEsc(n)}">${lbEsc(n)} (${collections[n].unitCount || 0})</option>`).join('')
    : '<option value="">No saved lists</option>';
  if (names.includes(want)) el.value = want;
}

function sbLoadCollectionSelected() {
  const name = document.getElementById('sb-collection-select')?.value;
  if (!name) { alert('No saved list selected.'); return; }
  const saved = sbStoredCollections()[name];
  if (!saved?.collection || !Object.keys(saved.collection).length) { alert('That saved list has no units.'); return; }
  sbCollection = saved.collection;
  document.getElementById('sb-status').textContent =
    `Collection loaded: ${Object.keys(sbCollection).length} unit names from "${name}". Click Load Catalog to browse.`;
  sbRenderBrowse();
  localStorage.setItem('bmtSavedCollections.lastName', name);
}

function sbDeleteCollectionSelected() {
  const name = document.getElementById('sb-collection-select')?.value;
  if (!name) { alert('No saved list selected.'); return; }
  if (!confirm(`Delete saved list "${name}"?`)) return;
  const collections = sbStoredCollections();
  delete collections[name];
  sbSetStoredCollections(collections);
  sbRefreshCollectionSelect();
}

function sbClearCatalog() {
  sbCatalog = [];
  document.getElementById('sb-unit-grid').innerHTML = '';
  document.getElementById('sb-catalog-count').textContent = '';
}

// Dumps a few raw unit records (all fields, unfiltered) into a selectable
// textarea so a user can copy real MUL response data straight out of their
// own browser for troubleshooting — no DevTools needed.
function sbShowDebugSample() {
  const out = document.getElementById('sb-debug-out');
  if (!out) return;
  if (!sbCatalog.length) {
    out.style.display = 'block';
    out.value = 'No catalog loaded yet — click Load Catalog first.';
    return;
  }

  // Prefer the currently active type tab so the sample matches what's on
  // screen (e.g. BattleMechs), rather than always whatever type happened
  // to merge in first.
  const typeOf = u => u.Type?.Name || 'Other';
  const pool = sbActiveType !== 'all' ? sbCatalog.filter(u => typeOf(u) === sbActiveType) : sbCatalog;

  // Group by Class (chassis) to surface duplicate-variant clusters — the
  // fastest way to see what field actually differs between an included and
  // an excluded copy of the "same" design.
  const groups = {};
  pool.forEach(u => { const c = u.Class || u.Name; (groups[c] = groups[c] || []).push(u); });
  const dupClasses = Object.keys(groups).filter(c => groups[c].length > 1).slice(0, 3);

  let sample, note;
  if (dupClasses.length) {
    sample = dupClasses.flatMap(c => groups[c]);
    note = `${pool.length} units in "${sbActiveType === 'all' ? 'All' : sbActiveType}". Showing ${dupClasses.length} duplicate-Class cluster(s) (${sample.length} records) to compare what differs between variants:`;
  } else {
    sample = pool.slice(0, 5);
    note = `${pool.length} units in "${sbActiveType === 'all' ? 'All' : sbActiveType}". No duplicate Class found in this pool — showing first ${sample.length}:`;
  }

  out.value = `// ${note}\n\n` + JSON.stringify(sample, null, 2);
  out.style.display = 'block';
  out.focus();
  out.select();
}

async function sbFetchCatalog() {
  const factionIds = sbCurrentFactionIds();
  const eraId      = document.getElementById('sb-era')?.value || '';
  const status     = document.getElementById('sb-status');
  if (!factionIds.length && !eraId) { status.textContent = 'Select a faction and era first.'; return; }
  if (!factionIds.length)           { status.textContent = 'Select a faction first.'; return; }
  if (!eraId)                       { status.textContent = 'Select an era first.'; return; }

  status.textContent = 'Loading catalog from Master Unit List…';
  sbCatalog = [];
  sbActiveType = 'all';
  document.getElementById('sb-unit-grid').innerHTML = '';
  document.getElementById('sb-catalog-count').textContent = '';

  // Query once per unit type and merge — MUL's QuickList truncates results
  // when no Types filter is passed, which is why a single combined call was
  // silently dropping most of a large faction/era's units.
  const fetchOneType = async (typeId) => {
    const params = new URLSearchParams({ AvailableEras: eraId, minPV: '1', maxPV: '999', Types: String(typeId) });
    factionIds.forEach(id => params.append('Factions', id));
    const res = await fetch(`${MUL_API}?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} (Types=${typeId})`);
    const data = await res.json();
    return data.Units || data || [];
  };

  try {
    const results = await Promise.allSettled(SB_MUL_TYPE_IDS.map(fetchOneType));
    const failed = results.filter(r => r.status === 'rejected');
    const byId = new Map();
    results.forEach(r => { if (r.status === 'fulfilled') r.value.forEach(u => byId.set(u.Id, u)); });
    sbCatalog = [...byId.values()];

    if (!sbCatalog.length && failed.length) {
      throw new Error(failed[0].reason?.message || 'all type queries failed');
    }

    // Default to the first unit type so the catalog opens separated by tab
    sbActiveType = sbOrderedTypes(sbCatalog)[0] || 'all';

    // Build the abilities multi-select from this catalog
    sbBuildAbilOptions();
    sbUpdateAbilBtn();

    // Populate role dropdown
    const roles = [...new Set(sbCatalog.map(u => u.Role?.Name).filter(Boolean))].sort();
    const roleSel = document.getElementById('sb-filter-role');
    if (roleSel) {
      const prev = roleSel.value;
      roleSel.innerHTML = '<option value="">All roles</option>' +
        roles.map(r => `<option value="${lbEsc(r)}"${r===prev?' selected':''}>${lbEsc(r)}</option>`).join('');
    }

    const fName = factionIds.map(id => sbFactionMeta[id]?.name || id).join(' + ');
    const eLabel = SB_ERA_LABELS[eraId] || eraId;
    const ownedCount = sbCatalog.filter(u => sbIsOwned(u)).length;
    const ownedInfo = Object.keys(sbCollection).length ? ` · ${ownedCount} owned` : '';
    const warnInfo = failed.length ? ` · ${failed.length}/${SB_MUL_TYPE_IDS.length} type queries failed` : '';
    status.textContent = `${sbCatalog.length} units — ${fName}, ${eLabel}${ownedInfo}${warnInfo}`;
    sbRenderBrowse();
  } catch(e) {
    status.textContent = `Error: ${e.message}`;
  }
}

function sbSort(key) {
  if (sbSortKey === key) sbSortDir *= -1;
  else { sbSortKey = key; sbSortDir = 1; }
  sbRenderBrowse();
}

function sbRenderBrowse() {
  const tbody = document.getElementById('sb-unit-grid');
  if (!tbody) return;

  const ownedOnly    = document.getElementById('sb-owned-only')?.checked;
  const stdRulesOnly = document.getElementById('sb-standard-rules-only')?.checked;
  const nameFilter   = (document.getElementById('sb-filter-name')?.value || '').toLowerCase().trim();
  const roleFilter   = document.getElementById('sb-filter-role')?.value || '';
  const sizeMin      = parseInt(document.getElementById('sb-filter-size-min')?.value) || 0;
  const sizeMax      = parseInt(document.getElementById('sb-filter-size-max')?.value) || 9;
  const moveMin      = parseInt(document.getElementById('sb-filter-move-min')?.value) || 0;
  const moveMax      = parseInt(document.getElementById('sb-filter-move-max')?.value);
  const pvMin        = parseInt(document.getElementById('sb-filter-pv-min')?.value) || 0;
  const pvMax        = parseInt(document.getElementById('sb-filter-pv-max')?.value) || 9999;
  const dmgS         = parseInt(document.getElementById('sb-filter-dmg-s')?.value) || 0;
  const dmgM         = parseInt(document.getElementById('sb-filter-dmg-m')?.value) || 0;
  const dmgL         = parseInt(document.getElementById('sb-filter-dmg-l')?.value) || 0;
  const introMin     = parseInt(document.getElementById('sb-filter-intro-min')?.value) || 0;
  const introMax     = parseInt(document.getElementById('sb-filter-intro-max')?.value) || 9999;
  const hasCol       = Object.keys(sbCollection).length > 0;
  const inForceIds   = new Set(sbForce.map(f => f.unit.Id));

  const abilSel = [...sbAbilSel];

  // Active-filter count, shown as a chip on the collapsed Filters card so
  // it's clear something's filtering the list even while collapsed.
  const activeFilterCount = [
    !!nameFilter, !!roleFilter, abilSel.length > 0,
    sizeMin > 0, sizeMax < 9, moveMin > 0, !isNaN(moveMax),
    pvMin > 0, pvMax < 9999, dmgS > 0, dmgM > 0, dmgL > 0,
    introMin > 0, introMax < 9999, !!ownedOnly, !!stdRulesOnly,
  ].filter(Boolean).length;
  const chipEl = document.getElementById('sb-filter-count');
  if (chipEl) chipEl.textContent = activeFilterCount ? `${activeFilterCount} active` : '';

  let units = sbCatalog;
  if (ownedOnly && hasCol)  units = units.filter(u => sbIsOwned(u));
  if (stdRulesOnly)          units = units.filter(u => !u.Rules || u.Rules === 'Standard');
  if (nameFilter)            units = units.filter(u => (u.Name||'').toLowerCase().includes(nameFilter));
  if (roleFilter)            units = units.filter(u => (u.Role?.Name||'') === roleFilter);
  if (abilSel.length)        units = units.filter(u => {
    const bases = sbUnitAbilBases(u);
    return sbAbilMode === 'any' ? abilSel.some(a => bases.has(a)) : abilSel.every(a => bases.has(a));
  });
  if (sizeMin > 0)           units = units.filter(u => (u.BFSize||0) >= sizeMin);
  if (sizeMax < 9)           units = units.filter(u => (u.BFSize||0) <= sizeMax);
  if (moveMin > 0)           units = units.filter(u => sbMoveNum(u) >= moveMin);
  if (!isNaN(moveMax))       units = units.filter(u => sbMoveNum(u) <= moveMax);
  if (pvMin > 0)             units = units.filter(u => (u.BFPointValue||0) >= pvMin);
  if (pvMax < 9999)          units = units.filter(u => (u.BFPointValue||0) <= pvMax);
  if (dmgS > 0)              units = units.filter(u => sbDmgNum(u.BFDamageShort)  >= dmgS);
  if (dmgM > 0)              units = units.filter(u => sbDmgNum(u.BFDamageMedium) >= dmgM);
  if (dmgL > 0)              units = units.filter(u => sbDmgNum(u.BFDamageLong)   >= dmgL);
  if (introMin > 0)          units = units.filter(u => sbIntroYear(u) >= introMin);
  if (introMax < 9999)       units = units.filter(u => sbIntroYear(u) <= introMax);

  // Build the unit-type tabs from the filtered set, then narrow to the active tab
  sbBuildTypeTabs(units);
  if (sbActiveType !== 'all') {
    units = units.filter(u => (u.Type?.Name || 'Other') === sbActiveType);
  }

  // Sort
  units = [...units].sort((a, b) => {
    if (sbSortKey === 'Name')        return (a.Name||'').localeCompare(b.Name||'') * sbSortDir;
    if (sbSortKey === 'Role')        return (a.Role?.Name||'').localeCompare(b.Role?.Name||'') * sbSortDir;
    if (sbSortKey === 'BFAbilities') return (a.BFAbilities||'').localeCompare(b.BFAbilities||'') * sbSortDir;
    let av, bv;
    if (sbSortKey === 'BFMove')      { av = sbMoveNum(a); bv = sbMoveNum(b); }
    else if (sbSortKey === 'DmgS')   { av = sbDmgNum(a.BFDamageShort);  bv = sbDmgNum(b.BFDamageShort); }
    else if (sbSortKey === 'DmgM')   { av = sbDmgNum(a.BFDamageMedium); bv = sbDmgNum(b.BFDamageMedium); }
    else if (sbSortKey === 'DmgL')   { av = sbDmgNum(a.BFDamageLong);   bv = sbDmgNum(b.BFDamageLong); }
    else if (sbSortKey === 'Intro')  { av = sbIntroYear(a); bv = sbIntroYear(b); }
    else { av = a[sbSortKey]||0; bv = b[sbSortKey]||0; }
    return (av - bv) * sbSortDir;
  });

  // If collection loaded, float owned to top within sort
  if (hasCol && !ownedOnly) {
    units.sort((a, b) => (sbIsOwned(a)?0:1) - (sbIsOwned(b)?0:1));
  }

  // Update sort indicators (works for both <th> and the Dmg sub-labels)
  document.querySelectorAll('.sb-table [data-sk]').forEach(el => {
    el.classList.remove('sort-asc','sort-desc');
    if (el.getAttribute('data-sk') === sbSortKey) {
      el.classList.add(sbSortDir === 1 ? 'sort-asc' : 'sort-desc');
    }
  });

  document.getElementById('sb-catalog-count').textContent = `(${units.length} shown)`;

  // Store lookup
  tbody._umap = {};
  sbCatalog.forEach(u => { tbody._umap[u.Id] = u; });

  if (!units.length) {
    tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;color:var(--text3);padding:16px">No units match filters.</td></tr>`;
    return;
  }

  const unitRow = (u) => {
    const owned   = hasCol && sbIsOwned(u);
    const inForce = inForceIds.has(u.Id);
    const dmg     = `${u.BFDamageShort??'–'}/${u.BFDamageMedium??'–'}/${u.BFDamageLong??'–'}`;
    const abil    = (u.BFAbilities || '').trim();
    const role    = u.Role?.Name || '—';
    const mv      = u.BFMove || '—';
    const armor   = u.BFArmor ?? '—';
    const structure = u.BFStructure ?? '—';
    const ov      = u.BFOverheat || '—';
    const pv      = u.BFPointValue || '?';
    const intro   = u.DateIntroduced ?? '—';
    return `<tr class="sb-row${inForce?' in-force':''}" data-uid="${u.Id}">
      <td class="sb-col-name">${owned?'<span class="sb-owned-dot" title="Owned"></span>':''}${lbEsc(u.Name)}</td>
      <td class="sb-col-pv">${pv}</td>
      <td>${lbEsc(role)}</td>
      <td class="sb-col-dmg">${mv}</td>
      <td class="sb-col-dmg">${dmg}</td>
      <td class="sb-col-dmg">${armor}</td>
      <td class="sb-col-dmg">${structure}</td>
      <td class="sb-col-dmg">${ov}</td>
      <td class="sb-col-abil" title="${lbEsc(abil)}">${lbEsc(abil)}</td>
      <td class="sb-col-dmg">${lbEsc(String(intro))}</td>
      <td class="sb-col-add">${inForce
        ? '<span style="color:var(--green);font-size:11px">✓</span>'
        : `<button class="sb-add-btn" onclick="sbAddUnit(${u.Id})">+</button>`
      }</td>
    </tr>`;
  };

  if (sbActiveType !== 'all') {
    // Single type selected — flat list (the tab already names the type)
    tbody.innerHTML = units.map(unitRow).join('');
    return;
  }

  // "All" tab — group by unit type with section headers
  const groups = {};
  units.forEach(u => { const t = u.Type?.Name || 'Other'; (groups[t] = groups[t] || []).push(u); });
  const orderedTypes = Object.keys(groups).sort((a, b) => {
    const ia = SB_TYPE_ORDER.indexOf(a), ib = SB_TYPE_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });

  tbody.innerHTML = orderedTypes.map(t => {
    const list = groups[t];
    const ownedInGroup = hasCol ? list.filter(u => sbIsOwned(u)).length : 0;
    const ownedTag = ownedInGroup ? `<span class="sb-group-owned">${ownedInGroup} owned</span>` : '';
    return `<tr class="sb-group-row"><td colspan="11">${lbEsc(sbTypeLabel(t))}`
      + `<span class="sb-group-count">${list.length}</span>${ownedTag}</td></tr>`
      + list.map(unitRow).join('');
  }).join('');
}

function sbOrderedTypes(list) {
  const set = [...new Set(list.map(u => u.Type?.Name || 'Other'))];
  return set.sort((a, b) => {
    const ia = SB_TYPE_ORDER.indexOf(a), ib = SB_TYPE_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
}

function sbSetType(t) {
  sbActiveType = t;
  sbRenderBrowse();
}

// Build the unit-type tab row. Tabs come from the full catalog (so they don't
// vanish when other filters exclude a type); counts reflect the filtered set.
function sbBuildTypeTabs(filtered) {
  const wrap = document.getElementById('sb-type-tabs');
  if (!wrap) return;
  if (!sbCatalog.length) { wrap.innerHTML = ''; return; }

  const types  = sbOrderedTypes(sbCatalog);
  if (sbActiveType !== 'all' && !types.includes(sbActiveType)) sbActiveType = 'all';
  const hasCol = Object.keys(sbCollection).length > 0;
  const typeOf = u => u.Type?.Name || 'Other';
  const countOf = t => filtered.reduce((n, u) => n + (typeOf(u) === t ? 1 : 0), 0);
  const ownedOf = t => hasCol ? filtered.reduce((n, u) => n + (typeOf(u) === t && sbIsOwned(u) ? 1 : 0), 0) : 0;
  const allOwned = hasCol ? filtered.filter(sbIsOwned).length : 0;

  const tab = (key, label, count, owned) =>
    `<button class="sb-type-tab${sbActiveType === key ? ' on' : ''}" onclick="sbSetType('${String(key).replace(/'/g, "\\'")}')">`
    + `${lbEsc(label)}<span class="sb-tt-count">${count}</span>`
    + `${owned ? `<span class="sb-tt-owned">${owned}◆</span>` : ''}</button>`;

  wrap.innerHTML = tab('all', 'All', filtered.length, allOwned)
    + types.map(t => tab(t, sbTypeLabel(t), countOf(t), ownedOf(t))).join('');
}

function sbAddUnit(id) {
  const unit = document.getElementById('sb-unit-grid')?._umap?.[id];
  if (!unit) return;
  if (sbForce.length >= 500) { alert('Force is full (500 units max).'); return; }
  if (sbForce.some(f => f.unit.Id === id)) return;
  sbForce.push({ unit, skill: 4 });
  sbRenderForce();
  sbRenderBrowse();
}

function sbRemoveUnit(idx) {
  sbForce.splice(idx, 1);
  // Shift per-unit ability bonuses down so they stay attached to the units
  // that kept their position after the removed one.
  const shifted = {};
  Object.keys(sbUnitBonuses).forEach(k => {
    const i = parseInt(k, 10);
    if (i < idx) shifted[i] = sbUnitBonuses[k];
    else if (i > idx) shifted[i - 1] = sbUnitBonuses[k];
  });
  sbUnitBonuses = shifted;
  sbRenderForce();
  sbRenderBrowse();
}

function sbSetSkill(idx, val) {
  const skill = parseInt(val);
  if (!sbForce[idx]) return;
  sbForce[idx].skill = skill;
  sbRenderForce();
}

function sbClearForce() {
  sbForce = [];
  sbLanceSpecs = [];
  sbUnitBonuses = {};
  sbRenderForce();
  sbRenderBrowse();
}

function sbSetLanceSpec(groupIdx, val) {
  sbLanceSpecs[groupIdx] = val;
  sbRenderForce();
}

function sbSetUnitBonus(idx, ability) {
  if (ability) sbUnitBonuses[idx] = ability;
  else delete sbUnitBonuses[idx];
  sbRenderForce();
}

// Which per-unit abilities are already taken by other units in the same
// lance group (group membership is derived positionally — see sbRenderForce).
function sbGetLanceTaken(groupStart, groupEnd, excludeIdx) {
  const s = new Set();
  for (let i = groupStart; i < groupEnd; i++) {
    if (i === excludeIdx) continue;
    const b = sbUnitBonuses[i];
    if (b) s.add(b);
  }
  return s;
}

/* ── Drag-and-drop between lance groups (swaps position in sbForce, which
   also moves the unit into/out of whichever lance group that position
   belongs to; its ability bonus, if any, travels with it) ─────────────── */
function sbDragStart(e, idx) {
  sbDragSrc = idx;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(idx));
  setTimeout(() => {
    const el = document.getElementById(`sb-funit-${idx}`);
    if (el) el.classList.add('lb-dragging');
  }, 0);
}

function sbDragEnd() {
  document.querySelectorAll('.sb-force-unit.lb-dragging, .sb-force-unit.lb-drag-over')
    .forEach(el => { el.classList.remove('lb-dragging'); el.classList.remove('lb-drag-over'); });
}

function sbDragOver(e, idx) {
  e.preventDefault();
  if (sbDragSrc === null || sbDragSrc === idx) return;
  document.querySelectorAll('.sb-force-unit.lb-drag-over')
    .forEach(el => el.classList.remove('lb-drag-over'));
  const el = document.getElementById(`sb-funit-${idx}`);
  if (el) el.classList.add('lb-drag-over');
}

function sbDrop(e, idx) {
  e.preventDefault();
  const src = sbDragSrc;
  sbDragEnd();
  if (src === null || src === idx) return;

  const tmp = sbForce[idx];
  sbForce[idx] = sbForce[src];
  sbForce[src] = tmp;

  const bonA = sbUnitBonuses[idx], bonB = sbUnitBonuses[src];
  delete sbUnitBonuses[idx]; delete sbUnitBonuses[src];
  if (bonA !== undefined) sbUnitBonuses[src] = bonA;
  if (bonB !== undefined) sbUnitBonuses[idx] = bonB;

  sbRenderForce();
}

// Saved lances persist the full unit data alongside each unit's chosen
// skill, so a load doesn't depend on the catalog's faction/era still
// being selected — same approach as the Owned Units saved-roster feature.
function sbStoredLances() {
  try {
    return JSON.parse(localStorage.getItem(SB_SAVED_STORAGE_KEY) || '{}');
  } catch (_) {
    return {};
  }
}

function sbSetStoredLances(lances) {
  localStorage.setItem(SB_SAVED_STORAGE_KEY, JSON.stringify(lances));
}

// One-time migration: saved CSV Formation Builder lists (bmtSavedCsvLists.v1,
// pool of {query, unit}) become Skirmish saved forces (bmtSavedLances.v1,
// force of {unit, skill}) so they stay accessible now that the CSV tab is
// retired. Non-destructive — the old key is left in place — and guarded by a
// flag so it only ever runs once. Name collisions get a " (CSV)" suffix;
// unmatched pool rows (no MUL record) are dropped, matching what the
// formation builder could actually use.
function sbMigrateCsvLists() {
  if (localStorage.getItem('bmtSavedCsvLists.migrated')) return;
  let csvLists;
  try {
    csvLists = JSON.parse(localStorage.getItem('bmtSavedCsvLists.v1') || '{}');
  } catch (_) { csvLists = {}; }
  const names = Object.keys(csvLists);
  if (names.length) {
    const forces = sbStoredLances();
    names.forEach(n => {
      const units = (csvLists[n]?.pool || []).filter(r => r.unit).map(r => ({ unit: r.unit, skill: 4 }));
      if (!units.length) return;
      let key = n;
      if (forces[key]) key = `${n} (CSV)`;
      if (forces[key]) return; // already migrated under the suffixed name too
      forces[key] = {
        name: key,
        updatedAt: csvLists[n].updatedAt || new Date().toISOString(),
        unitCount: units.length,
        totalPV: units.reduce((s, f) => s + (f.unit.BFPointValue || 0), 0),
        force: units,
      };
    });
    sbSetStoredLances(forces);
  }
  localStorage.setItem('bmtSavedCsvLists.migrated', '1');
}

function sbSaveForcePrompt() {
  if (!sbForce.length) { alert('Add units to your force before saving.'); return; }
  const defaultName = localStorage.getItem('bmtSavedLances.lastName') || '';
  const name = prompt('Save force as:', defaultName);
  if (!name) return;
  const key = name.trim();
  if (!key) return;
  const lances = sbStoredLances();
  lances[key] = {
    name: key,
    updatedAt: new Date().toISOString(),
    unitCount: sbForce.length,
    totalPV: sbForce.reduce((s, f) => s + sbAdjPV(f.unit, f.skill), 0),
    force: sbForce,
  };
  sbSetStoredLances(lances);
  localStorage.setItem('bmtSavedLances.lastName', key);
  sbRefreshSavedSelect(key);
  alert(`Saved "${key}" with ${sbForce.length} units.`);
}

// Populates the saved-force <select> from storage, keeping the given name
// selected if provided (otherwise keeps whatever was already selected).
function sbRefreshSavedSelect(selectName) {
  const el = document.getElementById('sb-saved-select');
  if (!el) return;
  const lances = sbStoredLances();
  const names = Object.keys(lances).sort((a, b) => a.localeCompare(b));
  const want = selectName ?? el.value;
  el.innerHTML = names.length
    ? names.map(n => `<option value="${lbEsc(n)}">${lbEsc(n)} (${lances[n].unitCount || 0}u, ${lances[n].totalPV || 0}PV)</option>`).join('')
    : '<option value="">No saved forces</option>';
  if (names.includes(want)) el.value = want;
}

function sbLoadSelected() {
  const name = document.getElementById('sb-saved-select')?.value;
  if (!name) { alert('No saved force selected.'); return; }
  const saved = sbStoredLances()[name];
  if (!saved?.force?.length) { alert('That saved force has no units.'); return; }
  sbForce = saved.force;
  sbLanceSpecs = [];
  sbUnitBonuses = {};
  sbRenderForce();
  sbRenderBrowse();
  localStorage.setItem('bmtSavedLances.lastName', name);
}

function sbDeleteSelected() {
  const name = document.getElementById('sb-saved-select')?.value;
  if (!name) { alert('No saved force selected.'); return; }
  if (!confirm(`Delete saved force "${name}"?`)) return;
  const lances = sbStoredLances();
  delete lances[name];
  sbSetStoredLances(lances);
  sbRefreshSavedSelect();
}

// Chunk sbForce into lance (4) / star (5) groups, same rule sbRenderForce
// uses, for the shared card/sheet print builders below.
function sbForceGroups() {
  const factionId = sbCurrentFactionId();
  const isClan    = !!sbFactionMeta[factionId]?.isClan;
  const groupSize = isClan ? 5 : 4;
  const groups = [];
  for (let start = 0; start < sbForce.length; start += groupSize) {
    groups.push(sbForce.slice(start, start + groupSize));
  }
  return { groups, isClan };
}

// "Sk4" if every member shares a skill, "Sk3-6" if mixed.
function sbSkillTextForGroup(members) {
  const skills = [...new Set(members.map(m => m.skill))].sort((a, b) => a - b);
  return skills.length <= 1 ? `Sk${skills[0] ?? 4}` : `Sk${skills[0]}-${skills[skills.length - 1]}`;
}

// Standard Alpha Strike range-band to-hit modifiers and ranges — fixed game
// constants (same for every unit), not derived from unit data. Verified
// against the reference tool's source (inch figures used directly there):
// S 0-6", M 6"-24", L 24"-42", E >42" (hex equivalents: 0-3, 4-12, 13-21, 22+).
const SB_RANGE_BANDS = [
  { key: 'short',  label: 'S', mod: '+0', dist: '0-6"'   },
  { key: 'medium', label: 'M', mod: '+2', dist: '6"-24"' },
  { key: 'long',   label: 'L', mod: '+4', dist: '24"-42"' },
  { key: 'extreme',label: 'E', mod: '+6', dist: '> 42"' },
];

// Measure text width in px for a given CSS font string. A character-count
// heuristic overflowed the abilities box for wide characters (digits,
// "W"/"M"), so wrap by actual rendered width instead.
let sbMeasureCtx = null;
function sbTextWidth(str, font) {
  if (!sbMeasureCtx) sbMeasureCtx = document.createElement('canvas').getContext('2d');
  sbMeasureCtx.font = font;
  return sbMeasureCtx.measureText(str).width;
}

// Wrap a string into lines that fit within firstMax px (line 1) / contMax px
// (subsequent lines) at the given font, since SVG <text> doesn't auto-wrap.
function sbSvgWrapLines(str, font, firstMax, contMax) {
  const words = String(str || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  words.forEach(w => {
    const maxW = lines.length === 0 ? firstMax : contMax;
    const next = cur ? `${cur} ${w}` : w;
    if (sbTextWidth(next, font) > maxW && cur) { lines.push(cur); cur = w; }
    else cur = next;
  });
  if (cur) lines.push(cur);
  return lines;
}

// Fixed Alpha Strike critical-hit tracks: box count + effect text are the
// same for every 'Mech/IndustrialMech regardless of unit stats (verified
// against the reference tool's own source — these are boilerplate rules
// text, not per-unit data). Vehicles (SV/CV) get 5 MP boxes instead of 4.
// Critical-hit tracks — pip counts and effect text verified verbatim
// against the reference tool's source (fixed rules constants, not
// per-unit data). Engine is skipped for ProtoMechs; MP only applies to
// BattleMechs/ProtoMechs; Vehicles get a MOTIVE track instead of MP, with
// three sub-groups at different effect tiers, not a uniform pip row.
function sbCritTracks(type) {
  const t = (type || '').toUpperCase();
  const tracks = [];
  if (t !== 'PM') tracks.push({ label: 'ENGINE', pips: 2, text: '+1 Heat/Firing Weapons' });
  tracks.push({ label: 'FIRE CONTROL', pips: 4, text: '+2 To Hit Each' });
  if (t === 'BM' || t === 'PM') tracks.push({ label: 'MP', pips: 4, text: '½ Move & TMM Each' });
  tracks.push({ label: 'WEAPONS', pips: 4, text: '-1 Damage Each' });
  if (t === 'CV' || t === 'SV') {
    tracks.push({ label: 'MOTIVE', groups: [
      { pips: 2, text: '-2 MV' },
      { pips: 2, text: '½ Move & TMM Each' },
      { pips: 1, text: '0 MV' },
    ]});
  }
  return tracks;
}

// Double-circle pip (black outer ring + colored inner fill), matching the
// reference tool's dot style exactly.
function sbSvgDot(cx, cy, r, fill) {
  return `<circle cx="${cx}" cy="${cy}" r="${r+3}" fill="#000"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>`;
}

// Row of armor/structure pips (double-circle style), wrapping at 16/row.
function sbSvgPipRow(x, y, count, color) {
  const r = 10, gap = 29, perRow = 16;
  let out = '';
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / perRow), col = i % perRow;
    out += sbSvgDot(x + col * gap, y + row * gap, r, color);
  }
  return out;
}

// Self-drawn Alpha Strike stat card (SVG), used in place of embedding MUL's
// pre-rendered card image — so the PV shown reflects our own skill-adjusted
// value (MUL's static image can only ever show base PV), and printing
// doesn't depend on MUL's image endpoint staying reachable. Coordinates,
// colors, and text templates below are transcribed directly from the
// reference tool's source (a React/SVG BattleTech roster app), including
// its semi-transparent-white-box-over-artwork layering technique.
function sbCardSVG(u, skill) {
  // H leaves a 10px black margin below the footer bar (which sits at
  // y=610..645), matching the 10px border on the other three sides —
  // 640 clipped the footer's bottom 5px against the viewBox edge.
  const W = 1000, H = 655;
  const pv      = sbAdjPV(u, skill);
  const basePV  = u.BFPointValue || 0;
  const role    = u.Role?.Name || '—';
  const type    = u.BFType || (u.Type?.Name || '').slice(0, 2).toUpperCase() || '?';
  const size    = u.BFSize || '—';
  const isAero  = /^(AF|CF)$/i.test(type);
  const tmm     = lbCalcTMM(u);
  const move    = u.BFMove || '—';
  const armor   = u.BFArmor ?? 0;
  const struct_ = u.BFStructure ?? 0;
  const thresh  = u.BFThreshold ?? 0;
  const ov      = u.BFOverheat ?? 0;
  const dmg     = { short: u.BFDamageShort, medium: u.BFDamageMedium, long: u.BFDamageLong, extreme: u.BFDamageExtreme };
  const dmgMin  = { short: u.BFDamageShortMin, medium: u.BFDamageMediumMin, long: u.BFDamageLongMin, extreme: u.BFDamageExtemeMin };
  const showExtreme = (dmg.extreme || 0) > 0;
  const bands   = SB_RANGE_BANDS.filter(b => b.key !== 'extreme' || showExtreme);
  const abilFont  = '25px sans-serif';
  const abilPrefixW = sbTextWidth('SPECIAL: ', abilFont);
  const abilLines = sbSvgWrapLines(u.BFAbilities || '—', abilFont, 940 - abilPrefixW, 820);
  const crits   = sbCritTracks(type);
  const isInfantry = /infantry/i.test(u.Type?.Name || '');

  // Extra height only if abilities need more than the reference's 2-line
  // allowance, or the crit-hit box needs more rows than the fixed 260px
  // box (e.g. a vehicle's extra MOTIVE row) — everything else is fixed,
  // matching the source exactly.
  const critBoxH = Math.max(260, crits.length * 50 + 30);
  const extraCritH = Math.max(0, critBoxH - 260);
  const extraAbilH = Math.max(0, (abilLines.length - 2) * 25);
  const extraH = extraCritH + extraAbilH;
  const totalH = H + extraH;
  const footerY = 610 + extraH;

  let svg = `<svg viewBox="0 0 ${W} ${totalH}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block">`;
  svg += `<rect x="0" y="0" width="${W}" height="${totalH}" fill="rgb(0,0,0)"/>`;
  // Stops 20px above the footer bar (which is 10px narrower on the right,
  // ending at x=970 vs the card's x=990 edge) so the black card background
  // shows through there instead of a stray white notch peeking past the
  // footer's corner.
  svg += `<rect x="10" y="10" width="${W-20}" height="${footerY-30}" fill="rgb(255,255,255)"/>`;

  if (u.ImageUrl) {
    svg += `<image x="440" y="10" href="${lbEsc(u.ImageUrl)}" width="550" height="500"
      onerror="this.setAttribute('href','')"/>`;
  }

  svg += `<text x="20" y="50" font-family="sans-serif" font-size="40">${lbEsc((u.Name || '?').toUpperCase())}</text>`;

  svg += `<rect x="850" y="9" width="150" height="35" fill="rgb(0,0,0)"/>`;
  svg += `<text x="990" y="35" text-anchor="end" fill="rgb(255,255,255)" font-family="sans-serif" font-size="33">PV: ${pv}</text>`;
  if (pv !== basePV) svg += `<text x="988" y="60" text-anchor="end" font-family="sans-serif" font-size="20">Base PV: ${basePV}</text>`;

  // TP/SZ/TMM/MV + Role/Skill box
  svg += `<rect x="20" y="100" width="550" height="105" fill="rgb(0,0,0)" rx="18" ry="18"/>`;
  svg += `<rect x="25" y="105" width="540" height="95" fill="rgba(255,255,255,.8)" rx="15" ry="15"/>`;
  svg += `<text x="30" y="140" font-family="sans-serif" font-size="25">TP: ${lbEsc(type)}</text>`;
  svg += `<text x="150" y="140" font-family="sans-serif" font-size="25">SZ: ${lbEsc(size)}</text>`;
  if (!isAero) svg += `<text x="235" y="140" font-family="sans-serif" font-size="25">TMM: ${lbEsc(String(tmm))}</text>`;
  svg += `<text x="540" y="140" text-anchor="end" font-family="sans-serif" font-size="25">MV: ${lbEsc(move)}</text>`;
  svg += `<text x="30" y="180" font-family="sans-serif" font-size="25">ROLE: ${lbEsc(role.toUpperCase())}</text>`;
  svg += `<text x="540" y="180" text-anchor="end" font-family="sans-serif" font-size="25">SKILL: ${skill}</text>`;

  // Damage box
  svg += `<rect x="20" y="210" width="550" height="100" fill="rgb(0,0,0)" rx="18" ry="18"/>`;
  svg += `<rect x="25" y="215" width="540" height="90" fill="rgba(255,255,255,.8)" rx="15" ry="15"/>`;
  svg += `<text x="55" y="250" text-anchor="middle" font-family="sans-serif" font-size="14" transform="rotate(270, 58, 250)">DAMAGE</text>`;
  const labelColW = 130, colW = showExtreme ? 110 : 150;
  bands.forEach((b, i) => {
    const x = labelColW + colW * i;
    const val = dmg[b.key], valMin = dmgMin[b.key];
    const toHit = skill + parseInt(b.mod, 10);
    svg += `<text x="${x}" y="245" text-anchor="middle" font-family="sans-serif" font-size="20">${b.label} (${b.mod} | ${toHit}+)</text>`;
    svg += `<text x="${x}" y="300" text-anchor="middle" font-family="sans-serif" font-size="20">${b.dist}</text>`;
    svg += `<text x="${x}" y="280" text-anchor="middle" font-family="sans-serif" font-size="35">${(val ?? '—')}${valMin ? '*' : ''}</text>`;
  });

  // Heat Scale box
  svg += `<rect x="20" y="315" width="550" height="80" fill="rgb(0,0,0)" rx="18" ry="18"/>`;
  svg += `<rect x="25" y="320" width="540" height="70" fill="rgba(255,255,255,.8)" rx="15" ry="15"/>`;
  svg += `<text x="40" y="365" font-family="sans-serif" font-size="35">OV: ${ov}</text>`;
  svg += `<text x="240" y="363" text-anchor="end" font-family="sans-serif" font-size="15">HEAT SCALE</text>`;
  svg += `<rect x="295" y="325" width="265" height="60" fill="rgb(0,0,0)" rx="30" ry="30"/>`;
  const GRAY = 'rgb(102,102,102)', WHITE = 'rgb(255,255,255)';
  svg += `<rect x="325" y="330" width="25" height="50" fill="${GRAY}"/><circle cx="325" cy="355" r="25" fill="${GRAY}"/><text x="315" y="368" fill="${WHITE}" font-family="sans-serif" font-size="35">0</text>`;
  svg += `<rect x="355" y="330" width="45" height="50" fill="${GRAY}"/><text x="365" y="368" fill="${WHITE}" font-family="sans-serif" font-size="35">1</text>`;
  svg += `<rect x="405" y="330" width="45" height="50" fill="${GRAY}"/><text x="415" y="368" fill="${WHITE}" font-family="sans-serif" font-size="35">2</text>`;
  svg += `<rect x="455" y="330" width="45" height="50" fill="${GRAY}"/><text x="465" y="368" fill="${WHITE}" font-family="sans-serif" font-size="35">3</text>`;
  svg += `<rect x="505" y="330" width="25" height="50" fill="${GRAY}"/><circle cx="530" cy="355" r="25" fill="${GRAY}"/><text x="515" y="368" fill="${WHITE}" font-family="sans-serif" font-size="35">S</text>`;

  // Armor/Structure box
  svg += `<rect x="20" y="400" width="550" height="105" fill="rgb(0,0,0)" rx="18" ry="18"/>`;
  svg += `<rect x="25" y="405" width="540" height="95" fill="rgba(255,255,255,.8)" rx="15" ry="15"/>`;
  svg += `<text x="40" y="440" font-family="sans-serif" font-size="25">A: </text>`;
  svg += sbSvgPipRow(90, armor > 16 ? 420 : 432, armor, WHITE);
  svg += `<text x="40" y="485" font-family="sans-serif" font-size="25">S: </text>`;
  svg += sbSvgPipRow(90, 477, struct_, 'rgb(153,153,153)');
  if (thresh) {
    svg += `<text x="520" y="445" text-anchor="middle" font-family="sans-serif" font-size="35">TH</text>`;
    svg += `<text x="520" y="485" text-anchor="middle" font-family="sans-serif" font-size="35">${thresh}</text>`;
  }

  // Special/Abilities box (full width, grows if more than 2 lines needed)
  const abilBoxH = Math.max(60, 60 + extraAbilH);
  svg += `<rect x="20" y="510" width="960" height="${abilBoxH}" fill="rgb(0,0,0)" rx="18" ry="18"/>`;
  svg += `<rect x="25" y="515" width="950" height="${abilBoxH-10}" fill="rgba(255,255,255,.8)" rx="15" ry="15"/>`;
  svg += `<text x="30" y="540" font-family="sans-serif" font-size="25">SPECIAL:&nbsp;${lbEsc(abilLines[0] || '—')}</text>`;
  abilLines.slice(1).forEach((l, i) => {
    svg += `<text x="150" y="${561 + i*25}" font-family="sans-serif" font-size="25">${lbEsc(l)}</text>`;
  });

  // Critical Hits box (right column) — skipped for Infantry, matching source
  if (!isInfantry) {
    svg += `<rect x="580" y="245" width="400" height="${critBoxH}" fill="rgb(0,0,0)" rx="18" ry="18"/>`;
    svg += `<rect x="585" y="250" width="390" height="${critBoxH-10}" fill="rgba(255,255,255,.8)" rx="15" ry="15"/>`;
    svg += `<text x="785" y="275" text-anchor="middle" font-family="sans-serif" font-size="25">CRITICAL HITS</text>`;
    let lineY = 325;
    crits.forEach(c => {
      svg += `<text x="750" y="${lineY}" text-anchor="end" font-family="sans-serif" font-size="20">${c.label}</text>`;
      if (c.groups) {
        // Compound row (vehicle MOTIVE): sub-groups at different x offsets,
        // each with its own effect text below.
        let gx = 770;
        c.groups.forEach(g => {
          for (let i = 0; i < g.pips; i++) { svg += sbSvgDot(gx, lineY - 10, 15, WHITE); gx += 33; }
          svg += `<text x="${gx-g.pips*33+5}" y="${lineY+18}" font-family="sans-serif" font-size="8">${g.text}</text>`;
          gx += 12;
        });
      } else {
        for (let i = 0; i < c.pips; i++) svg += sbSvgDot(770 + i*33, lineY - 10, 15, WHITE);
        svg += `<text x="750" y="${lineY+18}" font-family="sans-serif" font-size="12">${c.text}</text>`;
      }
      lineY += 50;
    });
  }

  // Footer
  svg += `<rect x="10" y="${footerY}" width="960" height="35" fill="rgb(0,0,0)"/>`;
  svg += `<text x="20" y="${footerY+15}" fill="rgb(253,253,227)" font-family="sans-serif" font-weight="700" font-size="30">ALPHA STRIKE</text>`;
  svg += `<text x="980" y="${footerY+15}" text-anchor="end" fill="rgb(253,253,227)" font-family="sans-serif" font-weight="700" font-size="24">BMT</text>`;

  svg += `</svg>`;
  return svg;
}

// Builds the roster/summary page + paginated card grid HTML shared by the
// card-print flows. rows: [{ unit, skill }]. title: doc title. groupOf(idx):
// optional — returns a group label to insert as a break before that card
// (e.g. "Lance 1"); omit for a flat, ungrouped grid.
function sbCardsDocHtml(rows, title, groupOf) {
  const totalPV = rows.reduce((s, r) => s + sbAdjPV(r.unit, r.skill), 0);
  const totalTon = rows.reduce((s, r) => s + (parseInt(r.unit.Tonnage, 10) || 0), 0);

  const rosterRows = rows.map(r => `<tr>
    <td>${lbEsc(r.unit.Name)}</td>
    <td>${lbEsc(r.unit.Type?.Name || r.unit.BFType || '—')}</td>
    <td class="num">${r.skill}</td>
    <td class="num">${sbAdjPV(r.unit, r.skill)}</td>
    <td class="num">${r.unit.Tonnage || '—'}</td>
  </tr>`).join('');

  let cardCells = '';
  let lastGroup = undefined;
  rows.forEach((r, i) => {
    const group = groupOf ? groupOf(i) : undefined;
    if (group !== undefined && group !== lastGroup) {
      cardCells += `<div class="card-group-hdr">${lbEsc(group)}</div>`;
      lastGroup = group;
    }
    cardCells += `<div class="card-wrap">${sbCardSVG(r.unit, r.skill)}</div>`;
  });

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
  <title>${lbEsc(title)}</title>
  <style>
    * { box-sizing:border-box; margin:0; padding:0; }
    @page { size:letter; margin:0.4in; }
    body { font-family:Arial,sans-serif; background:#fff; color:#111; }
    h1 { font-size:20px; margin-bottom:4px; }
    .meta { font-size:11px; color:#555; margin-bottom:14px; }
    table { width:100%; border-collapse:collapse; font-size:12px; }
    th, td { border:1px solid #999; padding:5px 8px; text-align:left; }
    th { background:#ddd; font-weight:700; }
    td.num, th.num { text-align:right; }
    tfoot td { font-weight:700; background:#eee; }
    .roster-page { page-break-after:always; }
    .card-grid { display:grid; grid-template-columns:1fr 1fr; gap:0.25in; align-content:start; }
    .card-group-hdr { grid-column:1/-1; font-size:13px; font-weight:700; padding:6px 0 2px;
      border-top:2px solid #333; break-after:avoid; page-break-after:avoid; }
    .card-group-hdr:first-child { border-top:none; }
    .card-wrap { break-inside:avoid; page-break-inside:avoid; }
    .card-wrap svg { width:100%; height:auto; display:block; border:1px solid #bbb; border-radius:4px; }
    @media print { .no-print { display:none; } }
  </style></head><body>
  <div class="roster-page">
    <h1>${lbEsc(title)}</h1>
    <p class="meta">${rows.length} unit${rows.length !== 1 ? 's' : ''} &nbsp;·&nbsp; Total PV: ${totalPV} &nbsp;·&nbsp; Total Tonnage: ${totalTon}
      <span class="no-print">&nbsp;·&nbsp; Use <strong>Print → Save as PDF</strong> to download</span></p>
    <table>
      <thead><tr><th>Unit</th><th>Type</th><th class="num">Skill</th><th class="num">PV</th><th class="num">Tonnage</th></tr></thead>
      <tbody>${rosterRows}</tbody>
      <tfoot><tr><td colspan="3">${rows.length} Unit${rows.length !== 1 ? 's' : ''}</td><td class="num">${totalPV}</td><td class="num">${totalTon}</td></tr></tfoot>
    </table>
  </div>
  <div class="card-grid">${cardCells}</div>
  </body></html>`;
}

function sbDownloadCards() {
  if (!sbForce.length) { alert('Add units to your force first.'); return; }
  const { groups, isClan } = sbForceGroups();
  const rows = groups.flat();
  // Map each flat-row index back to its lance's label for the card-grid group headers
  const groupLabelForRow = [];
  groups.forEach((members, li) => members.forEach(() => groupLabelForRow.push(lbGroupLabel(isClan, li))));

  const html = sbCardsDocHtml(rows, 'Tournament Force — Alpha Strike Cards', i => groupLabelForRow[i]);
  const w = window.open('', '_blank');
  if (w) {
    w.document.write(html);
    w.document.close();
    w.addEventListener('load', () => setTimeout(() => w.print(), 500));
  }
}

async function sbOpenSheets() {
  if (!sbForce.length) { alert('Add units to your force first.'); return; }
  const { groups, isClan } = sbForceGroups();
  const totalPV = sbForce.reduce((s, f) => s + sbAdjPV(f.unit, f.skill), 0);
  await lbOpenSheetsCore({
    lances: groups.map(members => members.map(m => m.unit)),
    lanceTypes: groups.map(() => ''),
    cmdState: {},
    unitBonuses: {},
    fDef: { name: 'Tournament Force' },
    totalPV,
    isClan,
    getLancePV: (li) => groups[li].reduce((s, m) => s + sbAdjPV(m.unit, m.skill), 0),
    getSkillText: (li) => sbSkillTextForGroup(groups[li]),
    getUnitSkill: (li, si) => groups[li]?.[si]?.skill ?? 4,
  });
}

function sbRenderForce() {
  const listEl  = document.getElementById('sb-force-list');
  const pvEl    = document.getElementById('sb-pv-total');
  const barEl   = document.getElementById('sb-pv-bar');
  const rulesEl = document.getElementById('sb-rules-bar');
  const dmgEl   = document.getElementById('sb-dmg-totals');
  const abilEl  = document.getElementById('sb-abil-totals');
  if (!listEl) return;

  const totalPV  = sbForce.reduce((s, f) => s + sbAdjPV(f.unit, f.skill), 0);
  const unitCt   = sbForce.length;

  const pvLimit = parseInt(document.getElementById('sb-pv-limit')?.value) || 250;
  const pvWarn  = Math.round(pvLimit * 0.97);

  if (pvEl) pvEl.textContent = totalPV;
  if (barEl) {
    const pct = Math.min(100, (totalPV / pvLimit) * 100);
    barEl.style.width = pct + '%';
    barEl.style.background = totalPV > pvLimit ? 'var(--red)' : totalPV > pvWarn ? 'var(--orange)' : 'var(--green)';
  }

  if (rulesEl) {
    rulesEl.innerHTML = [
      { t:`${totalPV}/${pvLimit} PV`, c: totalPV>pvLimit?'bad':totalPV>pvWarn?'warn':'ok' },
      { t:`${unitCt} units`,   c: unitCt<7?'warn':unitCt<=12?'ok':'bad'  },
    ].map(r=>`<span class="sb-rule ${r.c}">${lbEsc(r.t)}</span>`).join('');
  }

  if (dmgEl) {
    const dmg = sbForce.reduce((acc, f) => {
      acc.short  += f.unit.BFDamageShort  || 0;
      acc.medium += f.unit.BFDamageMedium || 0;
      acc.long   += f.unit.BFDamageLong   || 0;
      return acc;
    }, { short: 0, medium: 0, long: 0 });
    dmgEl.innerHTML = `
      <span class="sb-rule">S: ${dmg.short}</span>
      <span class="sb-rule">M: ${dmg.medium}</span>
      <span class="sb-rule">L: ${dmg.long}</span>
    `;
  }

  if (abilEl) {
    const counts = sbSpecialCounts(sbForce);
    abilEl.innerHTML = counts.length
      ? counts.map(([code, n]) => `<span class="sb-abil-pill">${lbEsc(code)} ×${n}</span>`).join('')
      : '';
  }

  if (!sbForce.length) {
    listEl.innerHTML = '<div class="sb-empty-hint">No units selected.<br>Click units from the catalog to add.</div>';
    return;
  }

  const unitRow = (f, idx, perUnitList, taken) => {
    const adjPV  = sbAdjPV(f.unit, f.skill);
    const abil   = (f.unit.BFAbilities || '').trim();
    const opts   = SB_SKILL_LEVELS.map(s =>
      `<option value="${s}"${f.skill===s?' selected':''}>Sk${s}</option>`
    ).join('');
    const unitBonus = sbUnitBonuses[idx] || '';
    let perUnitHtml = '';
    if (perUnitList && perUnitList.length > 0) {
      const available = perUnitList.filter(a => !taken.has(a) || a === unitBonus);
      const bOpts = available.map(a =>
        `<option value="${a}" ${a===unitBonus?'selected':''}>${a}</option>`).join('');
      perUnitHtml = `<div class="lb-cmd-pick">
        <select onchange="sbSetUnitBonus(${idx},this.value)">
          <option value="">— pick ability —</option>${bOpts}
        </select>
      </div>`;
      if (unitBonus) perUnitHtml +=
        `<div class="lb-unit-abil" style="color:var(--orange)">★ ${unitBonus}</div>` +
        `<div class="lb-unit-abil" style="color:var(--text3)">${LB_ABILITY_DESC[unitBonus]||''}</div>`;
    }
    return `<div class="sb-force-unit" id="sb-funit-${idx}"
      draggable="true"
      ondragstart="sbDragStart(event,${idx})"
      ondragend="sbDragEnd(event)"
      ondragover="sbDragOver(event,${idx})"
      ondrop="sbDrop(event,${idx})">
      <div class="sb-force-name">
        ${lbEsc(f.unit.Name)}
        ${abil?`<small>${lbEsc(abil)}</small>`:''}
        ${perUnitHtml}
      </div>
      <select class="sb-skill-sel" onchange="sbSetSkill(${idx},this.value)">${opts}</select>
      <span class="sb-force-pv">${adjPV}</span>
      <button class="sb-force-remove" onclick="sbRemoveUnit(${idx})" title="Remove">✕</button>
    </div>`;
  };

  // Group the force into lances (IS, 4 units) or stars (Clan, 5 units) in
  // add order, each with an editable Lance Specialty picker (reuses the
  // formation engine's own qualification check — lbGetFactionTypeOpts —
  // to disable specialties this group's unit mix doesn't qualify for) and,
  // where the specialty allows it, a per-unit ability picker or lance-wide
  // ability note (reuses LB_TYPE_ABILITIES/LB_ABILITY_DESC).
  const factionId = sbCurrentFactionId();
  const isClan    = !!sbFactionMeta[factionId]?.isClan;
  const groupSize = isClan ? 5 : 4;
  const groupWord = isClan ? 'Star' : 'Lance';

  let html = '';
  for (let start = 0, g = 0; start < sbForce.length; start += groupSize, g++) {
    const end      = Math.min(start + groupSize, sbForce.length);
    const members  = sbForce.slice(start, end);
    const groupPV  = members.reduce((s, m) => s + sbAdjPV(m.unit, m.skill), 0);
    const full     = members.length === groupSize;
    const subNote  = full ? '' : `<span class="sb-lance-sub">${members.length}/${groupSize}</span>`;
    const curSpec  = sbLanceSpecs[g] || '';
    const specOpts = lbGetFactionTypeOpts(factionId, members.map(m => m.unit), curSpec)
      .map(o => `<option value="${o.v}"${o.v===curSpec?' selected':''}${o.disabled&&o.v!==curSpec?' disabled':''}>${lbEsc(o.t)}${o.disabled&&o.v===curSpec?' (no longer qualifies)':''}</option>`)
      .join('');
    const typeInfo    = LB_TYPE_ABILITIES[curSpec] || {};
    const lanceWideHtml = (typeInfo.lanceWide || []).map(a =>
      `<div style="margin:4px 0">
        <span class="lb-unit-abil" style="color:var(--orange)">★ ${a}</span>
        <div class="lb-unit-abil">${LB_ABILITY_DESC[a]||''}</div>
      </div>`
    ).join('');
    html += `<div class="sb-lance-group">
      <div class="sb-lance-head">
        <span class="sb-lance-title">${groupWord} ${g+1}${subNote}</span>
        <span class="sb-lance-pv">${groupPV} PV</span>
      </div>
      <select class="sb-lance-spec-sel" onchange="sbSetLanceSpec(${g},this.value)" title="Lance specialty">${specOpts}</select>
      ${lanceWideHtml}
      ${members.map((f, mi) => unitRow(f, start + mi, typeInfo.perUnit, sbGetLanceTaken(start, end, start + mi))).join('')}
    </div>`;
  }
  listEl.innerHTML = html;
}

// Count how many units in the force carry each Alpha Strike special ability
// (BFAbilities strings like "FLK1/1/1, HT2/2/0, IF2, MEL"), grouped by the
// ability code with any numeric rating stripped off. Counted once per unit
// even if a code somehow appears twice in its list.
function sbSpecialCounts(force) {
  const counts = {};
  force.forEach(f => {
    const abil = (f.unit.BFAbilities || '').trim();
    if (!abil || abil === '—') return;
    const seen = new Set();
    abil.split(',').forEach(tok => {
      const m = tok.trim().match(/^[A-Za-z]+/);
      if (!m) return;
      const code = m[0].toUpperCase();
      if (seen.has(code)) return;
      seen.add(code);
      counts[code] = (counts[code] || 0) + 1;
    });
  });
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/* ── SELF-DRAWN CLASSIC BATTLETECH RECORD SHEET ─────────────────────────────
   Renders a Classic BT record sheet as an SVG string (same approach as the
   Alpha Strike card in sbCardSVG) from the compact per-variant stats in
   sheets/mech-data.json (built offline by build_sheet_data.py from the SSW
   database). Phase 1 covers Biped 'Mechs; other motive types / unmatched
   units fall back to the existing embedded-PDF path in lbOpenSheetsCore. */


// Vendored biped silhouette paths + per-location armor/structure-circle
// coordinates (from jdgwf/battletech-tools, transcribed verbatim into
// sheets/rs-silhouettes.json — see build notes there). Lazily populated by
// lbOpenSheetsCore; when null, rsSheetSVG falls back to a simpler diagram.
let rsSilData = null;

// Official heat-effect thresholds (Total Warfare heat scale): these rows get
// the shaded "effect" background + a footnote asterisk on the real record
// sheet. Transcribed from HeatTrackSVG's own threshold list.
const RS_HEAT_EFFECT_ROWS = new Set([5,8,10,13,14,15,17,18,19,20,22,23,24,25,26,28,30]);

// Fixed Total Warfare heat-effects text (HEAT LEVEL -> EFFECT), transcribed
// from BattleMechHeatEffectsBoxSVG — same on every record sheet regardless
// of unit, since it's the universal heat scale rule, not per-mech data.
const RS_HEAT_EFFECTS = [
  [30,'Shutdown'], [28,'Ammo Exp. Avoid on 8+'], [26,'Shutdown Avoid on 10+'],
  [25,'-5 Movement Points'], [24,'+4 Modifier to Fire'], [23,'Ammo Exp. Avoid on 6+'],
  [22,'Shutdown Avoid on 8+'], [20,'-4 Movement Points'], [19,'Ammo Exp. Avoid on 4+'],
  [18,'Shutdown Avoid on 6+'], [17,'+3 Modifier to Fire'], [15,'-3 Movement Points'],
  [14,'Shutdown Avoid on 4+'], [13,'+2 Modifier to Fire'], [10,'-2 Movement Points'],
  [8,'+1 Modifier to Fire'], [5,'-1 Movement Points'],
];

// TechManual weapon/equipment stats: [crits, heat, dmg, min, sht, med, lng].
// Not present in the SSW XML (which only gives name/location/crit-index),
// so this is transcribed from the published rules — same footing as the
// Internal Structure Table already used in build_sheet_data.py. Covers the
// weapons that actually appear in the SSW roster (checked by frequency);
// anything not listed falls back gracefully (1 crit slot, blank stat cols)
// rather than breaking the table.
const RS_WEAPON_STATS = {
  'Small Laser': [1,1,3,0,1,2,3], 'Medium Laser': [1,3,5,0,3,6,9], 'Large Laser': [2,8,8,0,5,10,15],
  'ER Small Laser': [1,2,3,0,2,4,5], 'ER Medium Laser': [1,5,5,0,4,8,12], 'ER Large Laser': [2,12,8,0,7,14,19],
  'Small Pulse Laser': [1,2,3,0,1,2,3], 'Medium Pulse Laser': [1,4,6,0,2,4,6], 'Large Pulse Laser': [2,10,9,0,3,7,10],
  'Small X-Pulse Laser': [1,3,3,0,1,2,3], 'Medium X-Pulse Laser': [2,6,6,0,2,4,5],
  'ER Small Pulse Laser': [1,3,3,0,2,4,5], 'ER Medium Pulse Laser': [2,6,6,0,4,8,12], 'ER Large Pulse Laser': [3,13,9,0,7,14,19],
  'Flamer': [1,3,2,0,1,2,3],
  'PPC': [3,10,10,3,6,12,18], 'ER PPC': [3,15,10,0,7,14,23], 'Light PPC': [2,5,5,3,6,12,18],
  'Heavy PPC': [3,15,15,3,6,12,18], 'Snub-Nose PPC': [2,10,10,0,9,13,15],
  'Machine Gun': [1,0,2,0,1,2,3], 'Light Machine Gun': [1,0,1,0,2,4,6], 'Heavy Machine Gun': [1,0,3,0,1,2,3],
  'Autocannon/2': [1,1,2,4,8,16,24], 'Autocannon/5': [4,1,5,3,6,12,18], 'Autocannon/10': [7,3,10,0,5,10,15], 'Autocannon/20': [10,7,20,0,3,6,9],
  'AC/2': [1,1,2,4,8,16,24], 'AC/5': [4,1,5,3,6,12,18], 'AC/10': [7,3,10,0,5,10,15], 'AC/20': [10,7,20,0,3,6,9],
  'Light AC/2': [1,1,2,0,4,8,12], 'Light AC/5': [2,1,5,0,5,10,15],
  'Ultra AC/2': [3,1,2,2,7,14,21], 'Ultra AC/5': [5,1,5,2,6,13,20], 'Ultra AC/10': [7,3,10,0,6,13,20], 'Ultra AC/20': [10,7,20,0,3,7,10],
  'Rotary AC/2': [6,1,2,0,4,8,12], 'Rotary AC/5': [6,1,5,2,6,13,20],
  'LB 2-X AC': [3,1,2,4,8,17,25], 'LB 5-X AC': [6,1,5,3,6,12,18], 'LB 10-X AC': [6,2,10,0,6,12,18], 'LB 20-X AC': [11,6,20,0,3,6,9],
  'Gauss Rifle': [7,1,15,2,7,15,22], 'Light Gauss Rifle': [5,1,8,3,8,17,25], 'Heavy Gauss Rifle': [11,2,25,4,6,13,20],
  'Hatchet': [1,0,'Melee','–','–','–','–'], 'Sword': [1,0,'Melee','–','–','–','–'], 'Small Vibroblade': [1,1,'Melee','–','–','–','–'],
  'LRM-5': [1,2,'1/hit',6,7,14,21], 'LRM-10': [2,4,'1/hit',6,7,14,21], 'LRM-15': [3,5,'1/hit',6,7,14,21], 'LRM-20': [5,6,'1/hit',6,7,14,21],
  'SRM-2': [1,2,'2/hit',0,3,6,9], 'SRM-4': [1,3,'2/hit',0,3,6,9], 'SRM-6': [2,4,'2/hit',0,3,6,9],
  'Streak SRM-2': [1,2,'2/hit',0,3,6,9], 'Streak SRM-4': [2,3,'2/hit',0,3,6,9], 'Streak SRM-6': [2,4,'2/hit',0,3,6,9],
  'MRM-10': [1,2,'1/hit',0,3,8,15], 'MRM-20': [2,4,'1/hit',0,3,8,15], 'MRM-30': [3,6,'1/hit',0,3,8,15], 'MRM-40': [4,8,'1/hit',0,3,8,15],
  'MML-5': [2,3,'1-2/hit',0,3,6,9], 'MML-7': [3,4,'1-2/hit',0,3,6,9], 'MML-9': [3,5,'1-2/hit',0,3,6,9],
  'Rocket Launcher 10': [1,3,'1/hit',0,6,12,18], 'Rocket Launcher 15': [1,4,'1/hit',0,6,12,18], 'Rocket Launcher 20': [1,5,'1/hit',0,6,12,18],
  'Narc Missile Beacon': [2,0,'–',0,3,6,9], 'iNarc Launcher': [3,0,'–',0,3,6,9],
  'Anti-Missile System': [1,1,'–',0,1,2,3], 'TAG': [1,0,'–',0,5,9,15],
  'CASE': [1,0,'–','–','–','–','–'], 'CASE II': [1,0,'–','–','–','–','–'],
  'Guardian ECM Suite': [2,0,'–','–','–','–','–'], 'Beagle Active Probe': [2,0,'–','–','–','–','–'],
  'Electronic Warfare Equipment': [2,0,'–','–','–','–','–'], 'Communications Equipment': [1,0,'–','–','–','–','–'],
  'C3 Computer (Slave)': [1,0,'–','–','–','–','–'], 'C3 Computer (Master)': [5,0,'–','–','–','–','–'],
  'Improved C3 Computer': [2,0,'–','–','–','–','–'], 'Targeting Computer': [1,0,'–','–','–','–','–'],
};

// Ammo shots-per-ton (TechManual): used to render "Ammo (X) n/n" like the
// reference. Anything unlisted just shows the ammo name with no count.
// Clan weapon stats overrides ([crits, heat, dmg, min, sht, med, lng]) —
// same names as Inner Sphere gear but different numbers (e.g. a Clan ER PPC
// does 15 damage to the IS version's 10). Used when the unit's tech base is
// Clan; anything not listed falls through to the IS table.
const RS_WEAPON_STATS_CLAN = {
  'ER Micro Laser': [1,1,2,0,1,2,4], 'ER Small Laser': [1,2,5,0,2,4,6],
  'ER Medium Laser': [1,5,7,0,5,10,15], 'ER Large Laser': [1,12,10,0,8,15,25],
  'Micro Pulse Laser': [1,1,3,0,1,2,3], 'Small Pulse Laser': [1,2,3,0,2,4,6],
  'Medium Pulse Laser': [1,4,7,0,4,8,12], 'Large Pulse Laser': [2,10,10,0,6,14,20],
  'Heavy Small Laser': [1,3,6,0,1,2,3], 'Heavy Medium Laser': [2,7,10,0,3,6,9],
  'Heavy Large Laser': [3,18,16,0,5,10,15],
  'ER PPC': [2,15,15,0,7,14,23], 'Flamer': [1,3,2,0,1,2,3], 'ER Flamer': [1,4,2,0,3,5,7],
  'Plasma Cannon': [1,7,'Heat',0,6,12,18],
  'LB 2-X AC': [3,1,2,4,10,20,30], 'LB 5-X AC': [4,1,5,3,8,15,24],
  'LB 10-X AC': [5,2,10,0,6,12,18], 'LB 20-X AC': [9,6,20,0,4,8,12],
  'Ultra AC/2': [2,1,2,2,9,18,27], 'Ultra AC/5': [3,1,5,0,7,14,21],
  'Ultra AC/10': [4,3,10,0,6,12,18], 'Ultra AC/20': [8,7,20,0,4,8,12],
  'Gauss Rifle': [6,1,15,2,7,15,22], 'AP Gauss Rifle': [1,1,3,0,3,6,9],
  'HAG/20': [6,4,'1/hit',2,8,16,24], 'HAG/30': [8,6,'1/hit',2,8,16,24], 'HAG/40': [10,8,'1/hit',2,8,16,24],
  'Machine Gun': [1,0,2,0,1,2,3], 'Light Machine Gun': [1,0,1,0,2,4,6], 'Heavy Machine Gun': [1,0,3,0,1,2,3],
  'LRM-5': [1,2,'1/hit',0,7,14,21], 'LRM-10': [1,4,'1/hit',0,7,14,21],
  'LRM-15': [2,5,'1/hit',0,7,14,21], 'LRM-20': [4,6,'1/hit',0,7,14,21],
  'SRM-2': [1,2,'2/hit',0,3,6,9], 'SRM-4': [1,3,'2/hit',0,3,6,9], 'SRM-6': [1,4,'2/hit',0,3,6,9],
  'Streak SRM-2': [1,2,'2/hit',0,4,8,12], 'Streak SRM-4': [1,3,'2/hit',0,4,8,12], 'Streak SRM-6': [2,4,'2/hit',0,4,8,12],
  'ATM-3': [2,2,'1-3/hit',4,5,10,15], 'ATM-6': [3,4,'1-3/hit',4,5,10,15],
  'ATM-9': [4,6,'1-3/hit',4,5,10,15], 'ATM-12': [5,8,'1-3/hit',4,5,10,15],
  'Anti-Missile System': [1,1,'–',0,1,2,3], 'Narc Missile Beacon': [1,0,'–',0,4,8,12],
  'Targeting Computer': [1,0,'–','–','–','–','–'], 'ECM Suite': [1,0,'–','–','–','–','–'],
  'Active Probe': [1,0,'–','–','–','–','–'],
};

const RS_AMMO_SHOTS = {
  'AC/2':45,'Autocannon/2':45,'Light AC/2':45,'Ultra AC/2':45,'Rotary AC/2':45,'LB 2-X AC':45,
  'AC/5':20,'Autocannon/5':20,'Light AC/5':20,'Ultra AC/5':20,'Rotary AC/5':20,'LB 5-X AC':20,
  'AC/10':10,'Autocannon/10':10,'Ultra AC/10':10,'LB 10-X AC':10,
  'AC/20':5,'Autocannon/20':5,'Ultra AC/20':5,'LB 20-X AC':5,
  'LRM-5':24,'LRM-10':12,'LRM-15':8,'LRM-20':6,
  'SRM-2':50,'SRM-4':25,'SRM-6':15,
  'Streak SRM-2':50,'Streak SRM-4':25,'Streak SRM-6':15,
  'MRM-10':24,'MRM-20':12,'MRM-30':8,'MRM-40':6,
  'Machine Gun':200,'Light Machine Gun':200,'Heavy Machine Gun':100,
  'Gauss Rifle':8,'Light Gauss Rifle':8,'Heavy Gauss Rifle':4,
  'Anti-Missile System':24,'Narc Missile Beacon':6,'iNarc Launcher':4,
};

// Official Cluster Hits Table (Total Warfare): missiles hit per 2d6 roll
// (rows are rolls 2..12), keyed by launcher size.
const RS_CLUSTER = {
  2:  [1,1,1,1,1,1,2,2,2,2,2],
  3:  [1,1,1,2,2,2,2,2,3,3,3],
  4:  [1,2,2,2,2,3,3,3,3,4,4],
  5:  [1,2,2,3,3,3,3,4,4,5,5],
  6:  [2,2,3,3,4,4,4,5,5,6,6],
  7:  [2,2,3,4,4,4,4,6,6,7,7],
  8:  [3,3,4,4,5,5,5,6,6,8,8],
  9:  [3,3,4,5,5,5,5,7,7,9,9],
  10: [3,3,4,6,6,6,6,8,8,10,10],
  12: [4,4,5,8,8,8,8,10,10,12,12],
  15: [5,5,6,9,9,9,9,12,12,15,15],
  20: [6,6,9,12,12,12,12,16,16,20,20],
  30: [10,10,12,18,18,18,18,24,24,30,30],
  40: [12,12,18,24,24,24,24,32,32,40,40],
};

// Weapons/equipment that change the attacker's to-hit number (Total
// Warfare): [modifier, reason, conditional?]. The Targeting Computer is
// handled separately (it applies -1 to every direct-fire weapon rather
// than to itself). Conditional entries ('*') aren't folded into the Mod
// column automatically — the To-Hit Modifiers panel explains when they
// apply.
const RS_TOHIT_MODS = {
  'Small Pulse Laser': [-2, 'Pulse laser'], 'Medium Pulse Laser': [-2, 'Pulse laser'], 'Large Pulse Laser': [-2, 'Pulse laser'],
  'Small X-Pulse Laser': [-2, 'Pulse laser'], 'Medium X-Pulse Laser': [-2, 'Pulse laser'], 'Large X-Pulse Laser': [-2, 'Pulse laser'],
  'ER Small Pulse Laser': [-2, 'Pulse laser'], 'ER Medium Pulse Laser': [-2, 'Pulse laser'], 'ER Large Pulse Laser': [-2, 'Pulse laser'],
  'MRM-10': [1, 'MRM launcher'], 'MRM-20': [1, 'MRM launcher'], 'MRM-30': [1, 'MRM launcher'], 'MRM-40': [1, 'MRM launcher'],
  'Rocket Launcher 10': [1, 'Rocket launcher (one-shot)'], 'Rocket Launcher 15': [1, 'Rocket launcher (one-shot)'], 'Rocket Launcher 20': [1, 'Rocket launcher (one-shot)'],
  'LB 2-X AC': [-1, 'Firing cluster ammunition', true], 'LB 5-X AC': [-1, 'Firing cluster ammunition', true],
  'LB 10-X AC': [-1, 'Firing cluster ammunition', true], 'LB 20-X AC': [-1, 'Firing cluster ammunition', true],
};

// Launcher size for the Cluster Hits Table. Streaks are excluded — on a
// successful attack all of a Streak's missiles hit, no cluster roll.
function rsClusterSize(base) {
  if (/^Streak/i.test(base)) return null;
  const mm = base.match(/^(?:LRM|SRM|MRM|MML|i?ATM)-(\d+)$/i) || base.match(/^Rocket Launcher (\d+)$/i);
  if (!mm) return null;
  const size = parseInt(mm[1], 10);
  return RS_CLUSTER[size] ? size : null;
}

// SSW equipment names look like "(IS) Large Laser", "(IS) @ LRM-15" (ammo),
// "(R) (IS) Medium Laser" (rear-mounted) — strip the tech-base/ammo/rear
// tags to get the plain weapon name used to key RS_WEAPON_STATS.
function rsCleanEquipName(raw) {
  let s = String(raw || '').trim();
  let rear = false;
  for (let i = 0; i < 4; i++) {
    let m;
    if ((m = s.match(/^\(R\)\s*/))) { rear = true; s = s.slice(m[0].length); continue; }
    if ((m = s.match(/^\((IS|CL)\)\s*/))) { s = s.slice(m[0].length); continue; }
    if ((m = s.match(/^@\s*/))) { s = s.slice(m[0].length); continue; }
    break;
  }
  return { base: s.trim(), rear };
}
function rsAmmoBaseName(base) {
  return base.replace(/\s*\([^)]*\)\s*$/, '').trim();
}
function rsWeaponCrits(eq) {
  if (eq.type === 'ammunition') return 1;
  const { base } = rsCleanEquipName(eq.name);
  const stats = RS_WEAPON_STATS[base];
  return stats ? stats[0] : 1;
}

// ── Faithful page-scale port of the reference record sheet ───────────────
// Everything below draws on the reference tool's own 2000x2600 canvas using
// its exact box coordinates and font sizes (battlemech-svg.tsx), so the
// output matches the original 1:1. The sheet is a static first-render only:
// every tracker/bubble is drawn blank with no interactivity — the only user
// actions are Print / Save as PDF.

// RecordSheetGroupBoxSVG: black rounded box + white inner + title pill.
function rsGroupBox(x, y, w, h, title) {
  const r = 15;
  let svg = `<rect rx="${r}" ry="${r}" x="${x}" y="${y + 20}" width="${w}" height="${h}" fill="#000"/>`
    + `<rect rx="${r}" ry="${r}" x="${x + 2}" y="${y + 22}" width="${w - 4}" height="${h - 4}" fill="#fff"/>`;
  if (title) {
    svg += `<rect rx="${r}" ry="${r}" x="${x + 35}" y="${y}" width="${w - 70}" height="40" fill="#000"/>`
      + `<text x="${x + w / 2}" y="${y + 32}" font-family="sans-serif" fill="#fff" text-anchor="middle" font-size="35" font-weight="700">${lbEsc(title.toUpperCase())}</text>`;
  }
  return svg;
}

// Plain-text helper (cuts template noise; all sheet text is sans-serif).
function rsT(x, y, fs, fw, anchor, txt, fill) {
  return `<text x="${x}" y="${y}" font-family="sans-serif" font-size="${fs}" font-weight="${fw}" text-anchor="${anchor}" fill="${fill || '#000'}">${txt}</text>`;
}

// DieSVG: the little movement dice next to Walking/Running/Jumping.
function rsDie(x, y, w, bg, pip, n) {
  let svg = `<rect rx="5" ry="5" x="${x}" y="${y}" width="${w}" height="${w}" fill="${bg}" stroke="#000" stroke-width="2"/>`;
  const r = w * 0.13;
  const pips = n === 1 ? [[0.5, 0.5]] : n === 2 ? [[0.3, 0.3], [0.7, 0.7]] : [[0.25, 0.25], [0.5, 0.5], [0.75, 0.75]];
  pips.forEach(([px, py]) => { svg += `<circle cx="${x + w * px}" cy="${y + w * py}" r="${r}" fill="${pip}"/>`; });
  return svg;
}

// PilotHitTrackSVG: the 6-box double-row hit / consciousness track.
function rsPilotHitTrack(x, y) {
  let svg = rsT(x, y, 25, 500, 'end', 'Hits:') + rsT(x, y + 40, 25, 500, 'end', 'Consc:');
  const conc = ['3+', '5+', '7+', '10+', '11+', 'Dead'];
  for (let i = 0; i < 6; i++) {
    const bx = x + 5 + i * 60;
    svg += `<rect x="${bx}" y="${y - 28}" width="60" height="40" fill="#000"/>`
      + `<rect x="${bx}" y="${y - 25}" width="59" height="34" fill="#fff"/>`
      + rsT(x + i * 60 + 35, y, 25, 500, 'middle', i + 1)
      + `<rect x="${bx}" y="${y + 10}" width="60" height="40" fill="#000"/>`
      + `<rect x="${bx}" y="${y + 12}" width="59" height="36" fill="#fff"/>`
      + rsT(x + i * 60 + 35, y + 40, 20, 500, 'middle', conc[i]);
  }
  return svg;
}

// ── Critical Hit Table construction ──────────────────────────────────────
// The SSW XML gives us each equipment item's location + a 0-based crit-slot
// INDEX within that location (verified against the Archer ARC-2K's real,
// published record sheet). Combined with the fixed, deterministic placement
// rules for head/actuators/engine/gyro, that's enough to build a faithful
// crit table without the reference tool's own construction-rules engine.
function rsEngineCTSlots(name) { return /compact/i.test(name || '') ? 3 : 6; }
function rsEngineSideSlots(name) {
  const n = name || '';
  if (/xl/i.test(n)) return 3;
  if (/light/i.test(n)) return 2;
  return 0;
}
function rsGyroSlots(name) {
  const n = name || '';
  if (/compact/i.test(n)) return 2;
  if (/heavy|xl/i.test(n)) return 6;
  return 4;
}

// Map SSW's engine name to the label the reference sheet prints in the crit
// slots (e.g. "Fusion Engine" -> "Standard Fusion").
function rsEngineLabel(name) {
  const n = (name || 'Fusion Engine').trim();
  if (/^fusion engine$/i.test(n)) return 'Standard Fusion';
  let base = n.replace(/\s*Engine$/i, '').trim();
  if (!/fusion/i.test(base)) base += ' Fusion';
  return base;
}

// Builds { hd, ct, lt, rt, la, ra, ll, rl } slot arrays. Each slot is null
// (roll again) or { t: label, id }; id groups the slots of one multi-crit
// item so the renderer can draw one capsule around the whole item, exactly
// like CritAllocationTableSVG does.
function rsBuildCrits(m) {
  // MTF-sourced records carry the COMPLETE authoritative slot lists
  // (including Endo Steel / Ferro-Fibrous filler) — use them directly.
  // Consecutive identical labels group into one capsule, matching how
  // multi-slot items render on the reference sheet.
  if (m.crits) {
    const out = {};
    let uid = 0;
    ['hd', 'ct', 'lt', 'rt', 'la', 'ra', 'll', 'rl'].forEach(loc => {
      const n = (loc === 'hd' || loc === 'll' || loc === 'rl') ? 6 : 12;
      const rows = m.crits[loc] || [];
      const slots = [];
      let prev = null, id = 0;
      for (let k = 0; k < n; k++) {
        const r = rows[k] || null;
        if (!r) { slots.push(null); prev = null; continue; }
        if (r !== prev) id = ++uid;
        slots.push({ t: r, id });
        prev = r;
      }
      out[loc] = slots;
    });
    return out;
  }

  const engineRaw = (m.engine && m.engine.name) || 'Fusion Engine';
  const engineName = rsEngineLabel(engineRaw);
  const gyroName = m.gyro || 'Standard Gyro';
  const act = m.actuators || { lla: true, rla: true, lh: true, rh: true };
  const mk = (n) => new Array(n).fill(null);
  const crits = { hd: mk(6), ct: mk(12), lt: mk(12), rt: mk(12), la: mk(12), ra: mk(12), ll: mk(6), rl: mk(6) };
  let uid = 0;
  const put = (loc, idx, label, span) => {
    span = span || 1;
    const id = ++uid;
    for (let s = 0; s < span; s++) {
      const p = idx + s;
      if (p >= 0 && p < crits[loc].length && crits[loc][p] === null) crits[loc][p] = { t: label, id };
    }
  };

  put('hd', 0, 'Life Support'); put('hd', 1, 'Sensors'); put('hd', 2, 'Cockpit');
  put('hd', 4, 'Sensors'); put('hd', 5, 'Life Support');

  ['ll', 'rl'].forEach(loc => {
    put(loc, 0, 'Hip'); put(loc, 1, 'Upper Leg Actuator');
    put(loc, 2, 'Lower Leg Actuator'); put(loc, 3, 'Foot');
  });

  let i = 0;
  put('la', i++, 'Shoulder'); put('la', i++, 'Upper Arm Actuator');
  if (act.lla) put('la', i++, 'Lower Arm Actuator');
  if (act.lh) put('la', i++, 'Hand Actuator');
  i = 0;
  put('ra', i++, 'Shoulder'); put('ra', i++, 'Upper Arm Actuator');
  if (act.rla) put('ra', i++, 'Lower Arm Actuator');
  if (act.rh) put('ra', i++, 'Hand Actuator');

  const engCT = rsEngineCTSlots(engineRaw);
  const engSide = rsEngineSideSlots(engineRaw);
  const gyroN = rsGyroSlots(gyroName);
  const firstEng = Math.min(3, engCT);
  put('ct', 0, engineName, firstEng);
  put('ct', firstEng, gyroName, gyroN);
  if (engCT > firstEng) put('ct', firstEng + gyroN, engineName, engCT - firstEng);
  if (engSide) { put('lt', 0, engineName, engSide); put('rt', 0, engineName, engSide); }

  (m.equipment || []).forEach(eq => {
    const loc = (eq.loc || '').toLowerCase();
    if (!crits[loc]) return;
    const idx = parseInt(eq.crit, 10);
    if (isNaN(idx) || idx < 0) return;
    const { base, rear } = rsCleanEquipName(eq.name);
    let label, span;
    if (eq.type === 'ammunition') {
      const ab = rsAmmoBaseName(base);
      const shots = RS_AMMO_SHOTS[ab];
      label = `Ammo (${ab})` + (shots ? ` ${shots}/${shots}` : '');
      span = 1;
    } else if (eq.type === 'jumpjet') {
      label = base; span = 1;
    } else {
      label = base + (rear ? ' [R]' : '');
      span = rsWeaponCrits(eq);
    }
    put(loc, idx, label, span);
  });

  return crits;
}

// CritAllocationTableSVG: one location's slot list. fontSize 25, row pitch
// 31, gray capsule (rx15, 275 wide) around each item's run of slots, gray
// "(roll again)" for empty slots, and 1-3 / 4-6 die brackets for 12-slot
// locations (with the extra blank line between the two halves).
function rsCritTable(x, y, slots) {
  const rowH = 31, boxW = 275;
  const line = (i) => i + (i >= 6 ? 1 : 0);
  let rects = '', texts = '';
  let i = 0;
  while (i < slots.length) {
    if (slots[i]) {
      let j = i;
      while (j + 1 < slots.length && slots[j + 1] && slots[j + 1].id === slots[i].id) j++;
      const y0 = y + line(i) * rowH - 23;
      const h = (line(j) - line(i) + 1) * rowH - 6;
      rects += `<rect x="${x - 10}" y="${y0}" rx="15" ry="15" width="${boxW}" height="${h}" stroke="#000" stroke-width="2" fill="rgb(200,200,200)"/>`;
      i = j + 1;
    } else i++;
  }
  slots.forEach((s, idx) => {
    const ty = y + line(idx) * rowH;
    texts += rsT(x - 40, ty, 25, 500, 'start', (idx % 6 + 1) + '.');
    if (s) {
      // Squeeze long labels (e.g. "Ammo (Machine Gun) 200/200") into the
      // capsule instead of letting them overflow its right edge.
      const fitW = boxW - 18;
      const squeeze = s.t.length * 13 > fitW ? ` textLength="${fitW}" lengthAdjust="spacingAndGlyphs"` : '';
      texts += `<text x="${x}" y="${ty}" font-family="sans-serif" font-size="25" font-weight="500" text-anchor="start"${squeeze}>${lbEsc(s.t)}</text>`;
    } else {
      texts += rsT(x, ty, 25, 100, 'start', '(roll again)', 'rgb(150,150,150)');
    }
  });
  let extra = '';
  if (slots.length > 6) {
    extra = rsT(x - 80, y + 2.75 * rowH, 31, 700, 'middle', '1-3')
      + rsT(x - 80, y + 9.75 * rowH, 31, 700, 'middle', '4-6');
  }
  return rects + texts + extra;
}

// Pick n bubble coordinates centred within a location's hand-placed slots
// (instead of filling from the first coordinate, which piles low armor
// values into one end of the limb). Slots are grouped into visual rows by
// cy and a contiguous row window nearest the vertical centre is chosen —
// but the window is then filled in the ORIGINAL authored coordinate order,
// which preserves the reference's neat hand-placed packing (picking
// per-row "middle" coordinates instead produced a zigzag on narrow
// diagonal limbs like arms and shins).
function rsCenteredPick(pts, n) {
  if (n >= pts.length) return pts.slice();
  if (n <= 0) return [];
  const order = pts.map((p, i) => ({ p, i }));
  const byY = order.slice().sort((a, b) => a.p[1] - b.p[1]);
  const rowOf = new Array(pts.length);
  let row = 0;
  rowOf[byY[0].i] = 0;
  for (let k = 1; k < byY.length; k++) {
    const tol = (byY[k].p[2] || 10) * 1.2;
    if (byY[k].p[1] - byY[k - 1].p[1] > tol) row++;
    rowOf[byY[k].i] = row;
  }
  const rowCount = row + 1;
  const caps = new Array(rowCount).fill(0);
  rowOf.forEach(r => caps[r]++);
  // Smallest contiguous row window with capacity >= n, nearest the middle.
  let best = null;
  for (let start = 0; start < rowCount; start++) {
    let sum = 0, end = start;
    while (end < rowCount && sum < n) { sum += caps[end]; end++; }
    if (sum < n) break;
    const score = Math.abs((start + end - 1) / 2 - (rowCount - 1) / 2) * 100 + (end - start);
    if (!best || score < best.score) best = { start, end, score };
  }
  const out = [];
  for (let k = 0; k < pts.length && out.length < n; k++) {
    if (rowOf[k] >= best.start && rowOf[k] < best.end) out.push(pts[k]);
  }
  return out;
}

// Render a full record sheet SVG for a matched biped mech record (from
// mech-data.json). pilot = { name, gunnery, piloting } optional.
function rsSheetSVG(m, pilot) {
  pilot = pilot || {};
  const S = rsSilData;
  const esc = lbEsc;
  const W = 2000;
  const H = 2600; // fixed page height — every sheet prints with identical geometry
  const a = m.armor || {}, st = m.structure || {};
  const mv = m.move || {};
  const T = rsT;
  let svg = '';

  // ── 'Mech Data (10,10 700x400) ──
  const gX = 10, gY = 10;
  svg += rsGroupBox(gX, gY, 700, 400, "'Mech Data");
  svg += T(gX + 10, gY + 80, 30, 700, 'start', 'Type:');
  // Model-first for designation codes ("ARC-2K Archer", like the reference),
  // chassis-first for config names ("Summoner Prime", not "Prime Summoner").
  const typeName = (/\d/.test(m.model || '')
    ? ((m.model || '') + ' ' + (m.chassis || ''))
    : ((m.chassis || '') + ' ' + (m.model || ''))).trim() || m.name || '';
  svg += T(gX + 10, gY + 120, 35, 500, 'start', esc(typeName));
  svg += T(gX + 15, gY + 160, 30, 700, 'start', 'Movement Points');
  svg += rsDie(gX + 20, gY + 185, 30, '#ffffff', '#000000', 1)
    + T(gX + 220, gY + 210, 30, 700, 'end', 'Walking:') + T(gX + 240, gY + 210, 30, 500, 'start', esc(mv.walk || 0));
  svg += rsDie(gX + 20, gY + 220, 30, '#000000', '#ffffff', 2)
    + T(gX + 220, gY + 245, 30, 700, 'end', 'Running:') + T(gX + 240, gY + 245, 30, 500, 'start', esc(mv.run || 0));
  svg += rsDie(gX + 20, gY + 255, 30, '#cc0000', '#ffffff', 3)
    + T(gX + 220, gY + 280, 30, 700, 'end', 'Jumping:') + T(gX + 240, gY + 280, 30, 500, 'start', esc(mv.jump || 0));
  svg += T(gX + 340, gY + 160, 25, 700, 'start', 'Tonnage:') + T(gX + 665, gY + 160, 25, 500, 'end', esc(m.tons || ''));
  svg += T(gX + 340, gY + 205, 25, 700, 'start', 'Tech Base:') + T(gX + 665, gY + 225, 25, 500, 'end', esc(m.techBase || '—'));
  svg += T(gX + 340, gY + 255, 25, 700, 'start', 'Era:') + T(gX + 665, gY + 280, 20, 500, 'end', esc(m.year || '—'));
  const cost = m.cost ? Math.round(parseFloat(m.cost)).toLocaleString() : '—';
  svg += T(gX + 15, gY + 350, 30, 700, 'start', 'Cost (CBills)') + T(gX + 15, gY + 380, 25, 500, 'start', esc(cost));
  svg += T(gX + 270, gY + 350, 30, 700, 'start', 'BattleValue (BV2)') + T(gX + 270, gY + 380, 25, 500, 'start', esc(m.bv || '—'));

  // ── Page title ──
  svg += T(W / 2 - 25, 80, 65, 700, 'middle', 'BATTLEMECH');
  svg += T(W / 2 - 25, 120, 35, 700, 'middle', 'Record Sheet');

  // ── Warrior Data (725,160 500x250) ──
  const pX = 725, pY = 160;
  svg += rsGroupBox(pX, pY, 500, 250, 'Warrior Data');
  if (pilot.name) svg += T(pX + 10, pY + 80, 25, 500, 'start', esc(pilot.name));
  else svg += `<line x1="${pX + 10}" y1="${pY + 85}" x2="${pX + 260}" y2="${pY + 85}" stroke="#000" stroke-width="2"/>`;
  svg += T(pX + 450, pY + 120, 35, 500, 'end', 'Piloting: ' + esc(pilot.piloting ?? 5));
  svg += T(pX + 450, pY + 160, 35, 500, 'end', 'Gunnery: ' + esc(pilot.gunnery ?? 4));
  svg += rsPilotHitTrack(pX + 100, pY + 200);

  // ── Weapons and Equipment (10,440 1215x460) ──
  // Reference column offsets from RecordSheetEquipmentTable. Ammo rows are
  // listed one per ton (with shots), then weapons grouped by name+location
  // with a Qty count. The box is shorter than the reference's 645 so the
  // Cluster Hits / To-Hit boxes below get a permanent home; row pitch
  // compresses on very heavy loadouts (max 17 rows in the dataset).
  const eqX = 10, eqY = 440, eqH = 460;
  svg += rsGroupBox(eqX, eqY, 1215, eqH, 'Weapons and Equipment');
  const hasTC = (m.equipment || []).some(eq => /Targeting Computer/i.test(eq.name));
  const isClanTech = /clan/i.test(m.techBase || '');
  const statsFor = (base) => (isClanTech && RS_WEAPON_STATS_CLAN[base]) || RS_WEAPON_STATS[base] || null;
  const wc = [15, 90, 435, 505, 575, 655, 735, 810, 885, 965].map(o => eqX + o);
  const heads = ['Qty', 'Type', 'Loc', 'Mod', 'Heat', 'Dmg', 'Min', 'Sht', 'Med', 'Lng'];
  heads.forEach((hh, k) => { svg += T(wc[k], eqY + 80, 32, 700, 'start', hh); });
  const ammoRows = [], weaponGroups = [];
  (m.equipment || []).forEach(eq => {
    if (eq.type === 'jumpjet') return; // structural — crit table only
    const { base, rear } = rsCleanEquipName(eq.name);
    if (eq.type === 'ammunition') {
      const ab = rsAmmoBaseName(base);
      const shots = RS_AMMO_SHOTS[ab];
      ammoRows.push({ label: shots ? `Ammo (${ab}) ${shots}/${shots}` : `Ammo (${ab})`, loc: eq.loc, qty: 1, stats: null, mod: null });
      return;
    }
    let label = base + (rear ? ' [R]' : '');
    const key = label + '|' + eq.loc;
    const prev = weaponGroups.find(g => g.key === key);
    if (prev) { prev.qty++; return; }
    // Net to-hit modifier: the weapon's own (unconditional) modifier plus
    // the Targeting Computer's -1 on direct-fire (energy/ballistic) weapons.
    let mod = null;
    if (eq.type === 'energy' || eq.type === 'ballistic' || eq.type === 'missile' || eq.type === 'physical' || eq.type === 'mgarray') {
      let v = 0;
      const wm = RS_TOHIT_MODS[base];
      if (wm && !wm[2]) v += wm[0];
      if (hasTC && (eq.type === 'energy' || eq.type === 'ballistic')) v -= 1;
      mod = v;
      if (wm && wm[2]) mod = { v, star: true }; // conditional — see panel
    }
    weaponGroups.push({ key, label, loc: eq.loc, qty: 1, stats: statsFor(base), mod, base, etype: eq.type });
  });
  const fmtMod = (v) => v > 0 ? '+' + v : v < 0 ? String(v) : '—';
  const eqRows = ammoRows.concat(weaponGroups);
  // Rows live between eqY+120 and the box's inner bottom; compress the
  // pitch (and font) only when a heavy loadout wouldn't fit at the
  // reference's 33px pitch.
  const eqAvail = eqY + 20 + eqH - 12 - (eqY + 93);
  const eqPitch = Math.min(33, Math.floor(eqAvail / Math.max(eqRows.length, 1)));
  const eqFS = Math.min(30, eqPitch - 4);
  eqRows.forEach((e, k) => {
    const ry = eqY + 120 + eqPitch * k - (33 - eqPitch);
    if (k % 2 === 0) svg += `<rect x="${wc[0] - 5}" y="${ry - eqFS * 0.75 - 4}" width="1180" height="${eqPitch + 4}" fill="rgb(200,200,200)"/>`;
    svg += T(wc[0] + 30, ry, eqFS, 100, 'middle', e.qty);
    // Squeeze long names (mostly ammo rows) so they don't run into Loc.
    const typeW = wc[2] - wc[1] - 12;
    const tSqueeze = e.label.length * eqFS * 0.48 > typeW ? ` textLength="${typeW}" lengthAdjust="spacingAndGlyphs"` : '';
    svg += `<text x="${wc[1]}" y="${ry}" font-family="sans-serif" font-size="${eqFS}" font-weight="100" text-anchor="start"${tSqueeze}>${esc(e.label)}</text>`;
    svg += T(wc[2] + 30, ry, eqFS, 100, 'middle', esc((e.loc || '—').toUpperCase()));
    if (e.mod !== null && e.mod !== undefined) {
      const isObj = typeof e.mod === 'object';
      const v = isObj ? e.mod.v : e.mod;
      svg += T(wc[3] + 30, ry, eqFS, v !== 0 ? 700 : 100, 'middle', fmtMod(v) + (isObj ? '*' : ''));
    }
    if (e.stats) {
      const [, heat, dmg, min, sht, med, lng] = e.stats;
      svg += T(wc[4] + 30, ry, eqFS, 100, 'middle', esc(heat));
      svg += T(wc[5] + 30, ry, eqFS, 100, 'middle', esc(dmg));
      svg += T(wc[6] + 30, ry, eqFS, 100, 'middle', esc(min === 0 ? '-' : min));
      svg += T(wc[7] + 30, ry, eqFS, 100, 'middle', esc(sht));
      svg += T(wc[8] + 30, ry, eqFS, 100, 'middle', esc(med));
      svg += T(wc[9] + 30, ry, eqFS, 100, 'middle', esc(lng));
    }
  });

  // ── Cluster Hits Table + To-Hit Modifiers (fixed strip at 10,930) ──
  // Always drawn, always in the same place, so every printed sheet has
  // identical geometry. These absorbed the space of the reference's GATOR
  // scratch-line box (dropped: it was all blanks — the Mod column and this
  // panel cover its job). Cluster table is horizontal: 2d6 rolls 2-12 as
  // columns, one row per launcher size the unit carries.
  const clY = 930, clH = 270;
  const clSizes = [];
  weaponGroups.forEach(g => {
    const size = g.base ? rsClusterSize(g.base) : null;
    if (size && clSizes.indexOf(size) === -1) clSizes.push(size);
  });
  clSizes.sort((x, y) => x - y);
  svg += rsGroupBox(10, clY, 700, clH, 'Cluster Hits Table');
  if (clSizes.length) {
    const rollX = (i) => 130 + i * 51 + 25;
    svg += T(52, clY + 95, 24, 700, 'start', 'Size');
    for (let roll = 2; roll <= 12; roll++) svg += T(rollX(roll - 2), clY + 95, 24, 700, 'middle', roll);
    const szPitch = Math.min(44, Math.floor(160 / clSizes.length));
    clSizes.forEach((sz, r) => {
      const ryy = clY + 95 + (r + 1) * szPitch;
      if (r % 2 === 0) svg += `<rect x="32" y="${ryy - 24}" width="660" height="${szPitch - 4}" fill="rgb(225,225,225)"/>`;
      svg += T(52, ryy, 24, 700, 'start', sz);
      for (let roll = 2; roll <= 12; roll++) svg += T(rollX(roll - 2), ryy, 24, 500, 'middle', RS_CLUSTER[sz][roll - 2]);
    });
    svg += T(52, clY + clH + 2, 18, 100, 'start', 'Roll 2D6 per launcher — result is the number of missiles that hit.');
  } else {
    svg += T(360, clY + clH / 2 + 20, 24, 100, 'middle', 'No missile weapons.', 'rgb(120,120,120)');
  }
  const modRows = [];
  weaponGroups.forEach(g => {
    if (!g.base) return;
    const wm = RS_TOHIT_MODS[g.base];
    if (wm && !modRows.some(r => r.name === g.label)) modRows.push({ name: g.label, mod: fmtMod(wm[0]) + (wm[2] ? '*' : '') });
    if (/^Streak/i.test(g.base) && !modRows.some(r => r.name === g.label + ': all missiles hit')) modRows.push({ name: g.label + ': all missiles hit', mod: '—' });
  });
  if (hasTC) modRows.push({ name: 'Targeting Computer (direct fire)', mod: '-1' });
  svg += rsGroupBox(730, clY, 495, clH, 'To-Hit Modifiers');
  if (modRows.length) {
    const mPitch = Math.min(40, Math.floor(190 / modRows.length));
    modRows.forEach((r, k) => {
      const ryy = clY + 100 + k * mPitch;
      svg += T(755, ryy, 24, 500, 'start', esc(r.name));
      svg += T(1195, ryy, 24, 700, 'end', esc(r.mod));
    });
    svg += T(755, clY + clH + 2, 18, 100, 'start', 'Included in Mod column; * cluster ammo only.');
  } else {
    svg += T(977, clY + clH / 2 + 20, 24, 100, 'middle', 'None.', 'rgb(120,120,120)');
  }

  // ── Armor Diagram (1240,10 745x1200) ──
  const abL = 1240, abT = 10, abW = 745;
  const abC = abL + abW / 2;
  svg += rsGroupBox(abL, abT, abW, 1200, 'Armor Diagram');
  if (S) {
    // Silhouettes at the reference's own placements; armor circles are
    // authored in the armor box's frame, so they draw at page coordinates.
    svg += `<svg x="1263" y="-10" width="700" height="990" viewBox="0 0 ${S.viewW} ${S.viewH}"><path d="${S.armorPath}" fill="#000"/></svg>`;
    const rSc = 400 / S.viewW;
    svg += `<svg x="1413" y="875" width="400" height="${Math.round(400 / S.viewW * S.viewH)}" viewBox="0 0 ${S.viewW} ${S.viewH}"><g transform="translate(0,${S.rearTransformY})"><path d="${S.rearPath}" fill="#000"/></g></svg>`;
    ['hd', 'ct', 'lt', 'rt', 'la', 'ra', 'll', 'rl'].forEach(loc => {
      const pts = S.coords[loc] || [];
      rsCenteredPick(pts, Math.min(a[loc] || 0, pts.length)).forEach(([cx, cy, cr]) => {
        svg += `<circle cx="${abL + cx}" cy="${abT + cy}" r="${cr - 3}" fill="#fff" stroke="#000" stroke-width="2"/>`;
      });
    });
    ['ctr', 'ltr', 'rtr'].forEach(loc => {
      const pts = S.rearCoords[loc] || [];
      rsCenteredPick(pts, Math.min(a[loc] || 0, pts.length)).forEach(([cx, cy, cr]) => {
        svg += `<circle cx="${1413 + cx * rSc}" cy="${875 + cy * rSc}" r="${cr * rSc - 3}" fill="#fff" stroke="#000" stroke-width="2"/>`;
      });
    });
  }
  // Armor labels (exact reference positions/sizes)
  svg += T(abC, abT + 70, 20, 700, 'middle', `HEAD [${a.hd || 0}]`);
  svg += T(abC - 55, abT + 95, 20, 700, 'end', 'LEFT TORSO') + T(abC - 85, abT + 115, 20, 700, 'end', `[${a.lt || 0}]`);
  svg += T(abC + 55, abT + 95, 20, 700, 'start', 'RIGHT TORSO') + T(abC + 85, abT + 115, 20, 700, 'start', `[${a.rt || 0}]`);
  svg += T(abL + 20, abT + 620, 20, 700, 'start', 'LEFT') + T(abL + 20, abT + 640, 20, 700, 'start', `ARM [${a.la || 0}]`);
  svg += T(abL + abW - 40, abT + 620, 20, 700, 'end', 'RIGHT') + T(abL + abW - 40, abT + 640, 20, 700, 'end', `ARM [${a.ra || 0}]`);
  svg += T(abL + 20, abT + 890, 20, 700, 'start', 'LEFT') + T(abL + 20, abT + 910, 20, 700, 'start', `LEG [${a.ll || 0}]`);
  svg += T(abL + abW - 20, abT + 890, 20, 700, 'end', 'RIGHT') + T(abL + abW - 20, abT + 910, 20, 700, 'end', `LEG [${a.rl || 0}]`);
  svg += T(abC, abT + 600, 20, 700, 'middle', 'CENTER') + T(abC, abT + 620, 20, 700, 'middle', 'TORSO') + T(abC, abT + 640, 20, 700, 'middle', `[${a.ct || 0}]`);
  svg += T(abC, abT + 1215, 20, 700, 'middle', `CENTER TORSO (REAR) [${a.ctr || 0}]`);
  svg += T(abC - 190, abT + 1090, 20, 700, 'end', 'LEFT TORSO') + T(abC - 190, abT + 1110, 20, 700, 'end', `(REAR) [${a.ltr || 0}]`);
  svg += T(abC + 190, abT + 1090, 20, 700, 'start', 'RIGHT TORSO') + T(abC + 190, abT + 1110, 20, 700, 'start', `(REAR) [${a.rtr || 0}]`);

  // ── Internal Structure (1250,1250 655x600) ──
  const isL = 1250, isT = 1250, isW = 655;
  const isC = isL + isW / 2;
  svg += rsGroupBox(isL, isT, isW, 600, 'Internal Structure');
  if (S) {
    const K = 420 / S.viewW;
    svg += `<svg x="1350" y="1275" width="420" height="${Math.round(420 / S.viewW * S.viewH)}" viewBox="0 0 ${S.viewW} ${S.viewH}"><path d="${S.structPath}" fill="#000"/></svg>`;
    ['hd', 'ct', 'lt', 'rt', 'la', 'ra', 'll', 'rl'].forEach(loc => {
      const pts = S.structCoords[loc] || [];
      rsCenteredPick(pts, Math.min(st[loc] || 0, pts.length)).forEach(([cx, cy, cr]) => {
        svg += `<circle cx="${1350 + cx * K}" cy="${1275 + cy * K}" r="${cr * K - 3}" fill="#fff" stroke="#000" stroke-width="2"/>`;
      });
    });
  }
  svg += T(isC, isT + 55, 15, 700, 'middle', `HEAD [${st.hd || 0}]`);
  svg += T(isC - 65, isT + 85, 15, 700, 'end', 'LEFT TORSO') + T(isC - 65, isT + 105, 15, 700, 'end', `[${st.lt || 0}]`);
  svg += T(isC + 65, isT + 85, 15, 700, 'start', 'RIGHT TORSO') + T(isC + 65, isT + 105, 15, 700, 'start', `[${st.rt || 0}]`);
  svg += T(isC - 200, isT + 310, 15, 700, 'end', 'LEFT') + T(isC - 200, isT + 330, 15, 700, 'end', `ARM [${st.la || 0}]`);
  svg += T(isC + 200, isT + 310, 15, 700, 'start', 'RIGHT') + T(isC + 200, isT + 330, 15, 700, 'start', `ARM [${st.ra || 0}]`);
  svg += T(isC - 150, isT + 570, 15, 700, 'end', 'LEFT') + T(isC - 150, isT + 590, 15, 700, 'end', `LEG [${st.ll || 0}]`);
  svg += T(isC + 150, isT + 570, 15, 700, 'start', 'RIGHT') + T(isC + 150, isT + 590, 15, 700, 'start', `LEG [${st.rl || 0}]`);
  // The CT label sits at knee level in the gap between the legs, stacked in
  // three short lines so it fits that narrow gap — the CT bubble strip runs
  // down the middle of the figure, so a torso-height label gets buried
  // under the bubbles on high-structure (heavy/assault) mechs.
  svg += T(isC, isT + 440, 15, 700, 'middle', 'CENTER')
    + T(isC, isT + 458, 15, 700, 'middle', 'TORSO')
    + T(isC, isT + 476, 15, 700, 'middle', `[${st.ct || 0}]`);

  // ── Critical Hit Table (10,1250 1225x1215) ──
  const cbL = 10, cbT = 1250, cbW = 1225;
  const c1 = cbL + 125, c2 = cbL + 513, c3 = cbL + 925;
  svg += rsGroupBox(cbL, cbT, cbW, 1215, 'Critical Hit Table');
  const crits = rsBuildCrits(m);
  svg += T(c1, cbT + 100, 30, 700, 'start', 'LEFT ARM') + rsCritTable(c1, cbT + 140, crits.la);
  svg += T(c2, cbT + 100, 30, 700, 'start', 'HEAD') + rsCritTable(c2, cbT + 140, crits.hd);
  svg += T(c3, cbT + 100, 30, 700, 'start', 'RIGHT ARM') + rsCritTable(c3, cbT + 140, crits.ra);
  svg += T(c1, cbT + 550, 30, 700, 'start', 'LEFT TORSO') + rsCritTable(c1, cbT + 575, crits.lt);
  svg += T(c2, cbT + 350, 30, 700, 'start', 'CENTER TORSO') + rsCritTable(c2, cbT + 375, crits.ct);
  svg += T(c3, cbT + 550, 30, 700, 'start', 'RIGHT TORSO') + rsCritTable(c3, cbT + 575, crits.rt);
  svg += T(c1, cbT + 1010, 30, 700, 'start', 'LEFT LEG') + rsCritTable(c1, cbT + 1050, crits.ll);
  svg += T(c3, cbT + 1010, 30, 700, 'start', 'RIGHT LEG') + rsCritTable(c3, cbT + 1050, crits.rl);

  // Component damage trackers (ComponentDamageSVG at cbW/3, cbT+750)
  const cdX = cbW / 3, cdY = cbT + 750, cdW = cbW / 3;
  svg += rsGroupBox(cdX, cdY, cdW, 190, '');
  const cdTx = cdX + cdW * 2 / 3 - 40;
  [['Engine Hits', 3], ['Gyro Hits', 2], ['Sensor Hits', 2], ['Life Support', 1]].forEach(([label, n], r) => {
    svg += T(cdTx, cdY + 60 + 40 * r, 30, 400, 'end', label);
    for (let k = 0; k < n; k++) {
      svg += `<circle cx="${cdTx + 30 + k * 50}" cy="${cdY + 50 + 40 * r}" r="17" fill="#fff" stroke="#000" stroke-width="2"/>`;
    }
  });

  // Damage transfer diagram (fixed art, centre column bottom)
  if (S && S.transferPath) {
    svg += `<svg x="${cbL + cbW / 2 - 75}" y="${cbT + 950}" width="150" height="${Math.round(150 / S.viewW * S.viewH)}" viewBox="0 0 ${S.viewW} ${S.viewH}"><g transform="translate(0,${S.transferTransformY})"><path d="${S.transferPath}" fill="#000"/></g></svg>`;
  }
  svg += T(cbL + cbW / 2, cbT + 1200, 25, 700, 'middle', 'DAMAGE TRANSFER');
  svg += T(cbL + cbW / 2, cbT + 1220, 25, 700, 'middle', 'DIAGRAM');

  // ── Heat Effects (1240,1885 435x575) ──
  const heX = 1240, heY = 1885;
  svg += rsGroupBox(heX, heY, 435, 575, 'Heat Effects');
  svg += T(heX + 90, heY + 75, 21, 700, 'end', 'HEAT');
  svg += T(heX + 90, heY + 102, 21, 700, 'end', 'LEVEL') + T(heX + 110, heY + 102, 21, 700, 'start', 'EFFECTS');
  RS_HEAT_EFFECTS.forEach(([lvl, eff], k) => {
    const hy = heY + 75 + 27 * (k + 2);
    svg += T(heX + 90, hy, 24, 500, 'end', lvl) + T(heX + 110, hy, 24, 500, 'start', esc(eff));
  });
  svg += T(heX + 20, heY + 587, 16, 100, 'start', '* on the Heat Scale marks these effect levels.');

  // ── Sinks (1690,1885 205x575) ──
  const skX = 1690, skY = 1885;
  const hsCount = (m.heatSinks || {}).count || 0;
  const hsType = ((m.heatSinks || {}).type || '').replace(/\s*Heat Sink$/i, '');
  svg += rsGroupBox(skX, skY, 205, 575, 'Sinks');
  svg += T(skX + 102.5, skY + 75, 21, 700, 'middle', 'HEAT SINKS');
  svg += T(skX + 102.5, skY + 129, 54, 700, 'middle', hsCount);
  svg += T(skX + 102.5, skY + 156, 21, 500, 'middle', esc(hsType));
  // Dots in balanced columns, centred in the box both ways (the reference's
  // own threshold-column layout sat off-centre for anything under 20 sinks).
  const hsN = Math.min(hsCount, 40);
  if (hsN > 0) {
    const hsCols = Math.ceil(hsN / 10);
    const perCol = Math.floor(hsN / hsCols), hsExtra = hsN % hsCols;
    const hsTop = skY + 180, hsAvail = 390;
    for (let c = 0; c < hsCols; c++) {
      const size = perCol + (c < hsExtra ? 1 : 0);
      const cx = skX + 102.5 + (c - (hsCols - 1) / 2) * 37.5;
      const y0 = hsTop + (hsAvail - size * 30) / 2 + 15;
      for (let r = 0; r < size; r++) {
        svg += `<circle cx="${cx}" cy="${y0 + r * 30}" r="12" fill="#fff" stroke="#000" stroke-width="2"/>`;
      }
    }
  }

  // ── Heat Scale strip (right page edge, 1920,1260) ──
  const htX = W - 80, htY = 1260;
  svg += T(htX + 30, htY + 10, 20, 700, 'middle', 'HEAT');
  svg += T(htX + 30, htY + 30, 20, 700, 'middle', 'SCALE');
  for (let k = 0; k <= 30; k++) {
    const by = htY + 60 + 37 * k;
    const effect = RS_HEAT_EFFECT_ROWS.has(k);
    svg += `<rect x="${htX}" y="${by}" width="60" height="37" fill="#000"/>`
      + `<rect x="${htX + 2}" y="${by + 2}" width="56" height="33" fill="${effect ? 'rgb(200,200,200)' : '#fff'}"/>`
      + T(htX + 27, htY + 89 + 37 * k, 27, 100, 'middle', k);
    if (effect) svg += T(htX + 43, htY + 83 + 37 * k, 22, 100, 'start', '*');
  }

  // ── Footer bar (trademark + attribution, like the reference prints) ──
  const tan = '#fdfde3';
  svg += `<rect x="0" y="${H - 100}" width="${W}" height="100" fill="#000"/>`;
  svg += T(20, H - 55, 20, 700, 'start', "Sheet layout from Jeff's BattleTech Tools", tan);
  svg += T(20, H - 25, 15, 700, 'start', 'https://jdgwf.github.io/battletech-tools/', tan);
  svg += T(450, H - 75, 15, 100, 'start', 'MechWarrior, BattleMech, ‘Mech and AeroTech are registered trademarks of The Topps Company, Inc. All Rights Reserved.', tan);
  svg += T(450, H - 45, 15, 100, 'start', 'Catalyst Game Labs and the Catalyst Game Labs logo are trademarks of InMediaRes Production, LLC.', tan);
  svg += T(1980, H - 35, 45, 900, 'end', 'BATTLETECH', tan);

  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block;background:#fff">`
    + `<rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>${svg}</svg>`;
}

/* ── OWNED UNITS ───────────────────────────────────── */
let lbOwnedRows = [];
let lbOwnedVisibleIds = [];
let lbOwnedSheetManifest = null;
const LB_OWNED_STORAGE_KEY = 'bmtOwnedRosters.v1';

function lbEsc(v) {
  return String(v ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function lbOwnedLoadCSV(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => lbOwnedParseCSV(e.target.result, file.name);
  reader.readAsText(file);
}

function lbOwnedParseLine(line) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i], next = line[i + 1];
    if (ch === '"' && quoted && next === '"') { cur += '"'; i++; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === ',' && !quoted) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function lbOwnedRowsFromCSV(text) {
  const raw = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!raw.length) return [];
  const parsed = raw.map(line => lbOwnedParseLine(line));
  const headerTokens = ['name','unit','unitname','variant','quantity','qty','count','faction','notes'];
  const headerRowIdx = parsed.findIndex(cols => {
    const norm = cols.map(h => h.toLowerCase().replace(/\s+/g, ''));
    return norm.filter(h => headerTokens.includes(h)).length >= 2 ||
      (norm.includes('name') && (norm.includes('variant') || norm.includes('quantity') || norm.includes('qty')));
  });
  const header = headerRowIdx >= 0 ? parsed[headerRowIdx].map(h => h.toLowerCase().replace(/\s+/g, '')) : ['name'];
  const body = headerRowIdx >= 0 ? raw.slice(headerRowIdx + 1) : raw;
  const idx = (...names) => names.map(n => header.indexOf(n)).find(i => i >= 0);
  const nameIdx = idx('name','unit','unitname');
  const varIdx = idx('variant','model');
  const qtyIdx = idx('quantity','qty','count');
  const factionIdx = idx('faction','factions','force','owningfaction','sourcefaction','house','clan');
  const notesIdx = idx('notes','note');
  const rows = [];

  body.forEach((line, rowNum) => {
    if (line.startsWith('#')) return;
    const cols = lbOwnedParseLine(line);
    const nonEmpty = cols.filter(Boolean);
    const lowerLine = line.toLowerCase();
    if (nonEmpty.length <= 1 && (
      lowerLine === 'mech units' ||
      lowerLine === 'unit' ||
      lowerLine === 'units' ||
      lowerLine.endsWith(' units') ||
      lowerLine.endsWith(' mechs')
    )) return;
    const name = (cols[nameIdx >= 0 ? nameIdx : 0] || '').trim();
    if (!name) return;
    const variant = varIdx >= 0 ? (cols[varIdx] || '').trim() : '';
    const qtyRaw = qtyIdx >= 0 ? parseInt(cols[qtyIdx], 10) : 1;
    const qty = Math.max(1, Math.min(100, Number.isFinite(qtyRaw) ? qtyRaw : 1));
    for (let copy = 1; copy <= qty; copy++) {
      rows.push({
        id: `owned-${Date.now()}-${rowNum}-${copy}-${Math.random().toString(36).slice(2)}`,
        sourceName: name,
        sourceVariant: variant,
        displayName: `${name}${variant ? ' ' + variant : ''}${qty > 1 ? ' #' + copy : ''}`,
        quantityIndex: copy,
        faction: factionIdx >= 0 ? (cols[factionIdx] || '').trim() : '',
        notes: notesIdx >= 0 ? (cols[notesIdx] || '').trim() : '',
        selected: false,
        matchStatus: 'unmatched',
        matchConfidence: 0,
        matches: [],
        factionChecks: {},
        matchFactionChecks: {},
        selectedFactionId: '',
        unit: null,
        mulData: null,
        filterData: {},
      });
    }
  });
  return rows;
}

function lbOwnedStoreUnitData(row, unit) {
  row.unit = unit || null;
  if (!unit) {
    row.mulData = null;
    const sourceFactions = lbOwnedFactionNamesForRow(row, []);
    row.filterData = {
      sourceFaction: row.faction || '',
      factionNames: sourceFactions,
      factionIds: lbOwnedFactionIdsForNames(sourceFactions),
      matchStatus: row.matchStatus || 'unmatched'
    };
    return;
  }
  const mulFactions = lbOwnedExtractFactionNames(unit);
  const factionNames = lbOwnedFactionNamesForRow(row, mulFactions);
  row.mulData = {
    id: unit.Id || null,
    name: unit.Name || '',
    type: unit.Type?.Name || '',
    typeId: unit.Type?.Id || unit.TypeId || '',
    role: unit.Role?.Name || '',
    technology: unit.Technology?.Name || '',
    tonnage: parseInt(unit.Tonnage, 10) || 0,
    size: unit.BFSize || 0,
    move: unit.BFMove || '',
    tmm: lbCalcTMM(unit),
    pv: parseInt(unit.BFPointValue, 10) || 0,
    armor: parseInt(unit.BFArmor, 10) || 0,
    structure: parseInt(unit.BFStructure, 10) || 0,
    short: unit.BFDamageShort ?? '',
    medium: unit.BFDamageMedium ?? '',
    long: unit.BFDamageLong ?? '',
    extreme: unit.BFDamageExtreme ?? '',
    overheat: unit.BFOverheat ?? '',
    abilities: unit.BFAbilities || '',
    intro: parseInt(unit.DateIntroduced, 10) || 0,
    factionNames,
    factionIds: lbOwnedFactionIdsForNames(factionNames),
    factionChecks: row.factionChecks || {},
  };
  row.filterData = {
    sourceFaction: row.faction || '',
    factionNames,
    factionIds: lbOwnedFactionIdsForNames(factionNames),
    type: row.mulData.type,
    typeId: String(row.mulData.typeId || ''),
    role: row.mulData.role,
    technology: row.mulData.technology,
    tonnage: row.mulData.tonnage,
    size: row.mulData.size,
    pv: row.mulData.pv,
    intro: row.mulData.intro,
    matchStatus: row.matchStatus,
  };
}

function lbOwnedFactionNamesForRow(row, extraNames) {
  const raw = [row.faction, ...(extraNames || [])].map(v => String(v || '').trim()).filter(Boolean);
  const aliases = {
    davion: ['Federated Suns'],
    'house davion': ['Federated Suns'],
    kurita: ['Draconis Combine'],
    'house kurita': ['Draconis Combine'],
    steiner: ['Lyran Commonwealth', 'Lyran Alliance'],
    'house steiner': ['Lyran Commonwealth', 'Lyran Alliance'],
    marik: ['Free Worlds League'],
    'house marik': ['Free Worlds League'],
    liao: ['Capellan Confederation'],
    'house liao': ['Capellan Confederation'],
    comstar: ['ComStar'],
    'word of blake': ['Word of Blake'],
    wob: ['Word of Blake'],
    mercenary: ['Mercenaries'],
    mercenaries: ['Mercenaries'],
    clan: ['IS Clan General'],
  };
  const names = [...raw];
  raw.forEach(v => {
    const key = v.toLowerCase();
    if (aliases[key]) names.push(...aliases[key]);
  });
  return [...new Set(names)];
}

function lbOwnedFactionIdsForNames(names) {
  const ids = [];
  (names || []).forEach(name => {
    const id = lbOwnedFactionIdByName(name);
    if (id) ids.push(id);
  });
  return [...new Set(ids)];
}

function lbOwnedExtractFactionNames(unit) {
  const buckets = [unit.Factions, unit.Faction, unit.AvailableFactions, unit.Availability?.Factions];
  const names = [];
  buckets.forEach(val => {
    if (!val) return;
    if (Array.isArray(val)) {
      val.forEach(f => {
        if (typeof f === 'string') names.push(f);
        else if (f?.Name) names.push(f.Name);
        else if (f?.Faction?.Name) names.push(f.Faction.Name);
      });
    } else if (typeof val === 'string') {
      val.split(/[,;|]/).forEach(v => names.push(v.trim()));
    } else if (val.Name) {
      names.push(val.Name);
    }
  });
  return names.filter(Boolean);
}

async function lbOwnedParseCSV(text, filename) {
  const status = document.getElementById('lb-owned-status');
  lbOwnedRows = lbOwnedRowsFromCSV(text);
  lbOwnedRefreshFactionFilter();
  lbOwnedRender();
  if (!lbOwnedRows.length) {
    status.textContent = 'No owned units found. CSV needs at least a Name column.';
    status.className = 'lb-status err';
    return;
  }
  status.textContent = `Loaded ${lbOwnedRows.length} owned unit rows from ${filename}. Matching against Master Unit List...`;
  status.className = 'lb-status';
  await lbOwnedMatchAll();
}

function lbOwnedRefreshFactionFilter() {
  lbOwnedRefreshSelect('lb-owned-type', 'All unit types',
    [...new Set(lbOwnedRows.map(r => r.filterData?.type || '').filter(Boolean))]);
  lbOwnedRefreshSelect('lb-owned-role', 'All roles',
    [...new Set(lbOwnedRows.map(r => r.filterData?.role || '').filter(Boolean))]);
  lbOwnedRefreshSelect('lb-owned-tech', 'All tech bases',
    [...new Set(lbOwnedRows.map(r => r.filterData?.technology || '').filter(Boolean))]);
}

function lbOwnedRefreshSelect(id, label, values) {
  const sel = document.getElementById(id);
  if (!sel) return;
  const current = sel.value;
  const opts = [...new Set(values.map(v => String(v).trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  sel.innerHTML = `<option value="">${lbEsc(label)}</option>` +
    opts.map(v => `<option value="${lbEsc(v)}">${lbEsc(v)}</option>`).join('');
  if (opts.includes(current)) sel.value = current;
}

function lbOwnedFactionChanged() {
  lbOwnedRender();
}

async function lbOwnedFactionFilterChanged() {
  const factionId = document.getElementById('lb-owned-source-faction')?.value || '';
  if (!factionId) {
    lbOwnedRender();
    return;
  }
  await lbOwnedEnsureFactionAvailability(factionId);
  lbOwnedRender();
}

function lbOwnedFactionIdByName(name) {
  const clean = String(name || '').trim().toLowerCase();
  const aliases = {
    davion: 'Federated Suns',
    kurita: 'Draconis Combine',
    steiner: 'Lyran Commonwealth',
    marik: 'Free Worlds League',
    liao: 'Capellan Confederation',
    wob: 'Word of Blake',
  };
  const target = (aliases[clean] || name || '').toLowerCase();
  return LB_FACTIONS.find(f => f.name.toLowerCase() === target)?.id || '';
}

async function lbOwnedEnsureFactionAvailability(factionId) {
  const factionName = LB_FACTIONS.find(f => f.id === String(factionId))?.name || factionId;
  const status = document.getElementById('lb-owned-status');
  if (!factionId) return;
  const rows = lbOwnedRows.filter(r => r.unit && r.unit.Id && r.factionChecks?.[factionId] === undefined);
  if (!rows.length) return;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (status) {
      status.textContent = `Checking ${factionName} availability ${i + 1} / ${rows.length}: ${row.unit.Name}...`;
      status.className = 'lb-status';
    }
    let available = false;
    try {
      const params = new URLSearchParams({ Name: row.unit.Name, Factions: factionId });
      const res = await fetch(`${MUL_API}?${params}`);
      const data = res.ok ? await res.json() : [];
      const units = data.Units || data || [];
      available = units.some(u => String(u.Id) === String(row.unit.Id));
      if (!available) {
        available = units.some(u => (u.Name || '').toLowerCase() === (row.unit.Name || '').toLowerCase());
      }
    } catch (_) {
      available = false;
    }
    row.factionChecks[factionId] = available;
    if (available && !row.filterData.factionIds.includes(factionId)) {
      row.filterData.factionIds.push(factionId);
    }
    if (available && !row.filterData.factionNames.includes(factionName)) {
      row.filterData.factionNames.push(factionName);
    }
    if (i < rows.length - 1) await new Promise(r => setTimeout(r, 80));
  }
  const found = lbOwnedRows.filter(r => r.factionChecks?.[factionId]).length;
  if (status) {
    status.textContent = `${found} owned unit${found !== 1 ? 's' : ''} available to ${factionName} based on MUL faction search.`;
    status.className = found ? 'lb-status' : 'lb-status err';
  }
}

async function lbOwnedEnrichFactionAvailability() {
  const status = document.getElementById('lb-owned-status');
  const factions = LB_FACTIONS.filter(f => f.id);
  const unitMap = new Map();
  lbOwnedRows.forEach(row => {
    if (!row.unit || !row.unit.Id) return;
    const key = String(row.unit.Id);
    if (!unitMap.has(key)) unitMap.set(key, { unit: row.unit, rows: [] });
    unitMap.get(key).rows.push(row);
  });
  const entries = [...unitMap.values()];
  let checked = 0;
  const total = entries.length * factions.length;

  for (const entry of entries) {
    for (const faction of factions) {
      checked++;
      if (status && checked % 8 === 1) {
        status.textContent = `Enriching faction availability ${checked} / ${total}: ${entry.unit.Name}`;
      }
      let available = entry.rows.some(row => {
        const currentId = String(row.unit?.Id || '');
        return currentId === String(entry.unit.Id) &&
          ((row.filterData?.factionIds || []).includes(faction.id) ||
           (row.filterData?.factionNames || []).includes(faction.name));
      });
      if (!available) {
        try {
          const params = new URLSearchParams({ Name: entry.unit.Name, Factions: faction.id });
          const res = await fetch(`${MUL_API}?${params}`);
          const data = res.ok ? await res.json() : [];
          const units = data.Units || data || [];
          available = units.some(u => String(u.Id) === String(entry.unit.Id)) ||
            units.some(u => (u.Name || '').toLowerCase() === (entry.unit.Name || '').toLowerCase());
        } catch (_) {
          available = false;
        }
      }
      entry.rows.forEach(row => {
        if (!row.matchFactionChecks) row.matchFactionChecks = {};
        if (!row.matchFactionChecks[entry.unit.Id]) row.matchFactionChecks[entry.unit.Id] = {};
        row.matchFactionChecks[entry.unit.Id][faction.id] = available;
        row.factionChecks[faction.id] = available;
      });
      if (checked % 16 === 0) await new Promise(r => setTimeout(r, 40));
    }
    entry.rows.forEach(row => {
      const availableIds = new Set(row.filterData?.factionIds || []);
      const availableNames = new Set(row.filterData?.factionNames || []);
      Object.entries(row.factionChecks || {}).forEach(([fid, ok]) => {
        if (!ok) return;
        const f = LB_FACTIONS.find(x => x.id === fid);
        availableIds.add(fid);
        if (f) availableNames.add(f.name);
      });
      row.filterData.factionNames = [...availableNames];
      row.filterData.factionIds = [...availableIds];
      row.mulData.factionNames = [...availableNames];
      row.mulData.factionIds = [...availableIds];
      row.filterData.factionChecks = row.factionChecks;
    });
  }
}

function lbOwnedUnitPassesFilters(row) {
  const u = row.unit;
  const fd = row.filterData || {};
  const ownedTerm = (document.getElementById('lb-owned-filter')?.value || '').toLowerCase();
  const state = document.getElementById('lb-owned-match-filter')?.value || '';
  const ownedFaction = document.getElementById('lb-owned-source-faction')?.value || '';
  const role = document.getElementById('lb-owned-role')?.value || '';
  const tech = document.getElementById('lb-owned-tech')?.value || '';
  const weight = document.getElementById('lb-owned-weight')?.value || '';
  const eraRange = lbParseEraVal(document.getElementById('lb-owned-era')?.value || '');
  const type = document.getElementById('lb-owned-type')?.value || '';

  const ownedHay = `${row.displayName} ${row.sourceName} ${row.sourceVariant} ${row.faction} ${row.notes}`.toLowerCase();
  if (ownedTerm && !ownedHay.includes(ownedTerm)) return false;
  if (state && row.matchStatus !== state) return false;
  if (ownedFaction) {
    const known = (fd.factionIds || []).includes(ownedFaction);
    const checked = row.factionChecks?.[ownedFaction] === true;
    const candidate = (row.matches || []).some(unit => lbOwnedCandidateAvailable(row, unit, ownedFaction));
    if (!known && !checked && !candidate) return false;
  }
  if (role && fd.role !== role) return false;
  if (tech && fd.technology !== tech) return false;
  if (!u) return true;
  if (weight) {
    const [minT, maxT] = weight.split(',').map(Number);
    const tons = fd.tonnage || 0;
    if (tons < minT || tons > maxT) return false;
  }
  if (eraRange && (fd.intro || 0) > eraRange.max) return false;
  if (type && fd.type !== type) return false;
  return true;
}

function lbOwnedCandidateAvailable(row, unit, factionId) {
  if (!unit || !factionId) return false;
  if (String(row.unit?.Id || '') === String(unit.Id) && row.factionChecks?.[factionId] === true) return true;
  return row.matchFactionChecks?.[unit.Id]?.[factionId] === true;
}

function lbOwnedAvailableFactionIds(row) {
  const ids = new Set(row.filterData?.factionIds || []);
  Object.entries(row.factionChecks || {}).forEach(([fid, ok]) => {
    if (ok) ids.add(fid);
  });
  return [...ids].filter(fid => LB_FACTIONS.some(f => f.id === fid))
    .sort((a, b) => {
      const fa = LB_FACTIONS.find(f => f.id === a)?.name || a;
      const fb = LB_FACTIONS.find(f => f.id === b)?.name || b;
      return fa.localeCompare(fb);
    });
}

function lbOwnedFactionDropdownHtml(row) {
  const ids = lbOwnedAvailableFactionIds(row);
  if (!ids.length) return '<small style="color:var(--text3)">No faction availability stored</small>';
  if (!row.selectedFactionId || !ids.includes(row.selectedFactionId)) row.selectedFactionId = ids[0];
  return `<select onchange="lbOwnedSetUnitFaction('${row.id}', this.value)">
    ${ids.map(fid => {
      const f = LB_FACTIONS.find(x => x.id === fid);
      return `<option value="${fid}"${row.selectedFactionId === fid ? ' selected' : ''}>${lbEsc(f?.name || fid)}</option>`;
    }).join('')}
  </select>`;
}

function lbOwnedMatchScore(row, unit) {
  const wanted = `${row.sourceName} ${row.sourceVariant}`.trim().toLowerCase();
  const src = row.sourceName.toLowerCase();
  const got = (unit.Name || '').toLowerCase();
  if (got === wanted) return 100;
  if (got === src) return 95;
  if (row.sourceVariant && got.includes(row.sourceVariant.toLowerCase())) return 82;
  if (got.includes(wanted) || wanted.includes(got)) return 78;
  if (got.includes(src) || src.includes(got.split(' ')[0] || got)) return 65;
  return 30;
}

async function lbOwnedMatchAll() {
  const status = document.getElementById('lb-owned-status');
  for (let i = 0; i < lbOwnedRows.length; i++) {
    const row = lbOwnedRows[i];
    status.textContent = `Matching ${i + 1} / ${lbOwnedRows.length}: ${row.displayName}...`;
    try {
      const params = new URLSearchParams({ Name: `${row.sourceName} ${row.sourceVariant}`.trim() });
      let res = await fetch(`${MUL_API}?${params}`);
      let data = res.ok ? await res.json() : [];
      let units = data.Units || data || [];
      if (!units.length && row.sourceVariant) {
        params.set('Name', row.sourceName);
        res = await fetch(`${MUL_API}?${params}`);
        data = res.ok ? await res.json() : [];
        units = data.Units || data || [];
      }
      units = units.filter(u => (u.BFSize || 0) > 0)
        .map(u => ({ unit: u, score: lbOwnedMatchScore(row, u) }))
        .sort((a, b) => b.score - a.score);
      row.matches = units.slice(0, 8).map(x => x.unit);
      row.matchConfidence = units[0]?.score || 0;
      lbOwnedStoreUnitData(row, row.matches[0] || null);
      row.matchStatus = !row.unit ? 'unmatched' : (row.matchConfidence >= 90 ? 'matched' : 'ambiguous');
      if (row.filterData) row.filterData.matchStatus = row.matchStatus;
    } catch (_) {
      row.matches = [];
      row.matchStatus = 'unmatched';
      row.matchConfidence = 0;
      lbOwnedStoreUnitData(row, null);
    }
    if (i < lbOwnedRows.length - 1) await new Promise(r => setTimeout(r, 120));
    if (i % 3 === 0) lbOwnedRender();
  }
  const matched = lbOwnedRows.filter(r => r.unit).length;
  const ambiguous = lbOwnedRows.filter(r => r.matchStatus === 'ambiguous').length;
  status.textContent = `Matched ${matched} of ${lbOwnedRows.length} owned units${ambiguous ? ` (${ambiguous} need review)` : ''}. Enriching faction availability...`;
  status.className = 'lb-status';
  await lbOwnedEnrichFactionAvailability();
  status.textContent = `Matched ${matched} of ${lbOwnedRows.length} owned units${ambiguous ? ` (${ambiguous} need review)` : ''}. Stored MUL data and faction availability are ready for filtering.`;
  status.className = matched === lbOwnedRows.length ? 'lb-status' : 'lb-status err';
  lbOwnedRefreshFactionFilter();
  lbOwnedRender();
}

function lbOwnedRender() {
  const table = document.getElementById('lb-owned-table');
  if (!table) return;
  const rows = lbOwnedRows.filter(lbOwnedUnitPassesFilters);
  lbOwnedVisibleIds = rows.map(r => r.id);
  lbOwnedRenderCounters(rows);
  if (!lbOwnedRows.length) {
    table.innerHTML = '';
    return;
  }
  const head = `<div class="lb-owned-row lb-owned-head">
    <span></span><span>Owned Unit</span><span>MUL Match</span><span>PV</span><span>Size</span><span>Status</span><span>Card</span><span>Delete</span>
  </div>`;
  table.innerHTML = head + rows.map(r => {
    const u = r.unit;
    const cardUrl = u && u.Id ? `https://masterunitlist.azurewebsites.net/Unit/Card/${u.Id}` : '';
    const factionId = document.getElementById('lb-owned-source-faction')?.value || '';
    const sortedMatches = [...(r.matches || [])].sort((a, b) => {
      if (!factionId) return 0;
      const av = lbOwnedCandidateAvailable(r, a, factionId) ? 1 : 0;
      const bv = lbOwnedCandidateAvailable(r, b, factionId) ? 1 : 0;
      if (bv !== av) return bv - av;
      return (b.BFPointValue || 0) - (a.BFPointValue || 0);
    });
    const matchOptions = sortedMatches.length
      ? `<select onchange="lbOwnedSetMatch('${r.id}', this.value)">
          ${sortedMatches.map(m => {
            const available = factionId && lbOwnedCandidateAvailable(r, m, factionId);
            const tag = available ? ' · faction' : '';
            return `<option value="${m.Id}"${u && m.Id === u.Id ? ' selected' : ''}>${lbEsc(m.Name)} (${m.BFPointValue || '?'} PV${tag})</option>`;
          }).join('')}
        </select>`
      : '<small style="color:var(--red)">No MUL match found</small>';
    return `<div class="lb-owned-row">
      <span><input type="checkbox" ${r.selected ? 'checked' : ''} ${u ? '' : 'disabled'} onchange="lbOwnedToggle('${r.id}', this.checked)"></span>
      <div class="lb-owned-main">
        <div class="lb-owned-title">${lbEsc(r.displayName)}<small>${lbEsc([r.faction, r.notes].filter(Boolean).join(' · '))}</small></div>
        <div class="lb-owned-match">${matchOptions}<small>${u ? lbEsc(u.Role?.Name || 'No role') + ' · MV ' + lbEsc(u.BFMove || '?') + ' · Intro ' + lbEsc(u.DateIntroduced || '?') : ''}</small></div>
        <div class="lb-owned-unit-faction">${u ? lbOwnedFactionDropdownHtml(r) : ''}</div>
        <div class="lb-owned-meta">
          <span class="lb-rpv">${u ? lbEsc(u.BFPointValue || '?') + ' PV' : '-'}</span>
          <span class="lb-rpill ${u ? LB_SZ_CLS[u.BFSize || 0] : ''}">${u ? lbEsc(LB_SZ[u.BFSize || 0] || '?') : '-'}</span>
          <span class="lb-owned-state ${r.matchStatus}">${r.matchStatus}</span>
        </div>
      </div>
      <span class="lb-owned-card-cell">
        ${cardUrl ? `<a href="${cardUrl}" target="_blank" title="View Alpha Strike card"><img class="lb-owned-card-img" src="${cardUrl}" alt="${lbEsc(u.Name)} Alpha Strike card"></a>` : '-'}
        ${u ? `<div class="lb-owned-card-actions">
          ${cardUrl ? `<a href="${cardUrl}" target="_blank" class="lb-btn-sm">Card</a>` : ''}
          <button class="lb-btn-sm" onclick="lbOwnedOpenSheet('${r.id}')">Sheet</button>
        </div>` : ''}
      </span>
      <span><button class="lb-owned-delete" onclick="lbOwnedDeleteRow('${r.id}')">Delete</button></span>
    </div>`;
  }).join('');
}

function lbOwnedRenderCounters(visibleRows) {
  const el = document.getElementById('lb-owned-counters');
  if (!el) return;
  if (!lbOwnedRows.length) {
    el.innerHTML = '';
    return;
  }
  const total = lbOwnedRows.length;
  const visible = visibleRows.length;
  const selected = lbOwnedRows.filter(r => r.selected).length;
  const matched = lbOwnedRows.filter(r => r.matchStatus === 'matched').length;
  const ambiguous = lbOwnedRows.filter(r => r.matchStatus === 'ambiguous').length;
  const unmatched = lbOwnedRows.filter(r => r.matchStatus === 'unmatched').length;
  const pv = visibleRows.reduce((s, r) => s + (r.unit ? (parseInt(r.unit.BFPointValue, 10) || 0) : 0), 0);
  el.innerHTML = `
    <span class="lb-owned-counter">Units <strong>${visible}</strong> / ${total}</span>
    <span class="lb-owned-counter">Selected <strong>${selected}</strong></span>
    <span class="lb-owned-counter ok">Matched <strong>${matched}</strong></span>
    <span class="lb-owned-counter warn">Review <strong>${ambiguous}</strong></span>
    <span class="lb-owned-counter bad">Unmatched <strong>${unmatched}</strong></span>
    <span class="lb-owned-counter">Visible PV <strong>${pv}</strong></span>`;
}

function lbOwnedSetMatch(rowId, unitId) {
  const row = lbOwnedRows.find(r => r.id === rowId);
  if (!row) return;
  const unit = row.matches.find(u => String(u.Id) === String(unitId)) || row.unit;
  lbOwnedStoreUnitData(row, unit);
  row.factionChecks = { ...(row.matchFactionChecks?.[unit?.Id] || row.factionChecks || {}) };
  Object.entries(row.factionChecks).forEach(([fid, ok]) => {
    if (!ok) return;
    const f = LB_FACTIONS.find(x => x.id === fid);
    if (!row.filterData.factionIds.includes(fid)) row.filterData.factionIds.push(fid);
    if (f && !row.filterData.factionNames.includes(f.name)) row.filterData.factionNames.push(f.name);
  });
  row.matchStatus = row.unit ? 'matched' : 'unmatched';
  row.matchConfidence = 100;
  const availableIds = lbOwnedAvailableFactionIds(row);
  row.selectedFactionId = availableIds[0] || '';
  if (row.filterData) row.filterData.matchStatus = row.matchStatus;
  lbOwnedRefreshFactionFilter();
  lbOwnedRender();
}

function lbOwnedSetUnitFaction(rowId, factionId) {
  const row = lbOwnedRows.find(r => r.id === rowId);
  if (!row) return;
  row.selectedFactionId = factionId;
}

function lbOwnedStoredRosters() {
  try {
    return JSON.parse(localStorage.getItem(LB_OWNED_STORAGE_KEY) || '{}');
  } catch (_) {
    return {};
  }
}

function lbOwnedSetStoredRosters(rosters) {
  localStorage.setItem(LB_OWNED_STORAGE_KEY, JSON.stringify(rosters));
}

function lbOwnedSaveRoster() {
  if (!lbOwnedRows.length) { alert('Upload or load owned units before saving a roster.'); return; }
  const defaultName = localStorage.getItem('bmtOwnedRosters.lastName') || 'My Owned Units';
  const name = prompt('Roster name:', defaultName);
  if (!name) return;
  const key = name.trim();
  if (!key) return;
  const rosters = lbOwnedStoredRosters();
  rosters[key] = {
    name: key,
    updatedAt: new Date().toISOString(),
    unitCount: lbOwnedRows.length,
    matchedCount: lbOwnedRows.filter(r => r.unit).length,
    rows: lbOwnedRows,
  };
  lbOwnedSetStoredRosters(rosters);
  localStorage.setItem('bmtOwnedRosters.lastName', key);
  const status = document.getElementById('lb-owned-status');
  if (status) {
    status.textContent = `Saved roster "${key}" locally with ${lbOwnedRows.length} units.`;
    status.className = 'lb-status';
  }
}

function lbOwnedRosterChoice(actionLabel) {
  const rosters = lbOwnedStoredRosters();
  const names = Object.keys(rosters).sort((a, b) => a.localeCompare(b));
  if (!names.length) { alert('No saved local rosters found.'); return null; }
  const list = names.map((n, i) => `${i + 1}. ${n} (${rosters[n].unitCount || rosters[n].rows?.length || 0} units)`).join('\n');
  const pick = prompt(`${actionLabel} roster:\n${list}\n\nEnter number or roster name:`);
  if (!pick) return null;
  const idx = parseInt(pick, 10);
  if (Number.isFinite(idx) && idx >= 1 && idx <= names.length) return names[idx - 1];
  return names.find(n => n.toLowerCase() === pick.trim().toLowerCase()) || null;
}

function lbOwnedLoadRosterPrompt() {
  const name = lbOwnedRosterChoice('Load');
  if (!name) return;
  const roster = lbOwnedStoredRosters()[name];
  if (!roster?.rows?.length) { alert('That saved roster has no units.'); return; }
  lbOwnedRows = roster.rows;
  lbOwnedRows.forEach(r => {
    if (!r.id) r.id = `owned-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    if (!r.factionChecks) r.factionChecks = {};
    if (!r.matchFactionChecks) r.matchFactionChecks = {};
    if (!r.filterData) r.filterData = {};
    if (!r.matches) r.matches = [];
  });
  lbOwnedRefreshFactionFilter();
  lbOwnedRender();
  localStorage.setItem('bmtOwnedRosters.lastName', name);
  const status = document.getElementById('lb-owned-status');
  if (status) {
    status.textContent = `Loaded local roster "${name}" with ${lbOwnedRows.length} units.`;
    status.className = 'lb-status';
  }
}

function lbOwnedDeleteRosterPrompt() {
  const name = lbOwnedRosterChoice('Delete');
  if (!name) return;
  if (!confirm(`Delete saved local roster "${name}"? This does not delete the currently displayed units.`)) return;
  const rosters = lbOwnedStoredRosters();
  delete rosters[name];
  lbOwnedSetStoredRosters(rosters);
  const status = document.getElementById('lb-owned-status');
  if (status) {
    status.textContent = `Deleted saved local roster "${name}".`;
    status.className = 'lb-status';
  }
}

function lbOwnedToggle(rowId, checked) {
  const row = lbOwnedRows.find(r => r.id === rowId);
  if (row && row.unit) row.selected = checked;
}

function lbOwnedSelectVisible(checked) {
  const ids = new Set(lbOwnedVisibleIds);
  lbOwnedRows.forEach(r => { if (ids.has(r.id) && r.unit) r.selected = checked; });
  lbOwnedRender();
}

function lbOwnedSelectedUnits() {
  return lbOwnedRows.filter(r => r.selected && r.unit && r.unit.Id).map(r => ({
    ...r.unit,
    _ownedLabel: r.displayName,
    _ownedRowId: r.id,
    _ownedFactionId: r.selectedFactionId || '',
  }));
}

function lbOwnedOpenSelectedCards() {
  const selected = lbOwnedSelectedUnits();
  if (!selected.length) { alert('Select matched owned units first.'); return; }
  const MUL_CARD = 'https://masterunitlist.azurewebsites.net/Unit/Card/';
  const totalPV = selected.reduce((s, u) => s + (parseInt(u.BFPointValue, 10) || 0), 0);
  const cardRows = selected.map(u => `<div class="card-wrap">
    <img src="${MUL_CARD}${u.Id}" alt="${lbEsc(u.Name)}">
    <div class="card-name">${lbEsc(u._ownedLabel || u.Name)}</div>
    <div class="pilot-info">
      <input class="p-name" type="text" placeholder="Pilot name">
      <div class="p-skills">
        <span>GU <input class="p-skill" type="number" min="1" max="8" value="4" title="Gunnery Skill"></span>
        <span>PI <input class="p-skill" type="number" min="1" max="8" value="5" title="Piloting Skill"></span>
      </div>
    </div>
  </div>`).join('');
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8">
  <title>Owned Units — Alpha Strike Cards</title>
  <style>
    * { box-sizing:border-box; margin:0; padding:0; }
    body { font-family:Arial,sans-serif; background:#fff; }
    .header { padding:12px 16px; border-bottom:2px solid #333; margin-bottom:10px; }
    .header h1 { font-size:16px; }
    .header p { font-size:11px; color:#555; margin-top:3px; }
    .card-row { display:flex; flex-wrap:wrap; gap:10px; padding:10px 14px; }
    .card-wrap { display:flex; flex-direction:column; align-items:center; width:220px; break-inside:avoid; }
    .card-wrap img { width:220px; height:auto; display:block; }
    .card-name { font-size:10px; font-weight:700; margin-top:3px; text-align:center; }
    .pilot-info { width:100%; margin-top:5px; }
    .p-name { width:100%; border:1px solid #aaa; border-radius:2px; padding:2px 4px; font-size:10px; }
    .p-skills { display:flex; gap:8px; margin-top:3px; font-size:10px; font-weight:700; align-items:center; }
    .p-skill { width:32px; border:1px solid #aaa; border-radius:2px; padding:2px; text-align:center; font-size:10px; font-weight:700; }
    @media print { body { margin:0; } .header { margin-bottom:4px; } }
  </style></head><body>
    <div class="header">
      <h1>Owned Units — Alpha Strike Cards</h1>
      <p>${selected.length} selected unit${selected.length !== 1 ? 's' : ''} · Total PV: ${totalPV}</p>
    </div>
    <div class="card-row">${cardRows}</div>
  </body></html>`);
  w.document.close();
  w.addEventListener('load', () => setTimeout(() => w.print(), 500));
}

async function lbOwnedOpenSelectedSheets() {
  const selected = lbOwnedSelectedUnits();
  if (!selected.length) { alert('Select matched owned units first.'); return; }
  const totalPV = selected.reduce((s, u) => s + (parseInt(u.BFPointValue, 10) || 0), 0);
  await lbOpenSheetsCore({
    lances: [selected],
    lanceTypes: [''],
    cmdState: {},
    unitBonuses: {},
    fDef: { name: 'Owned Units' },
    totalPV,
    isClan: false,
    getLancePV: () => totalPV,
    getSkillText: () => 'Regular',
  });
}

async function lbOwnedLoadSheetManifest() {
  if (lbOwnedSheetManifest) return lbOwnedSheetManifest;
  const sheetsBase = new URL('sheets/', LB_SHARED_BASE).href;
  try {
    const res = await fetch(sheetsBase + 'manifest.json');
    lbOwnedSheetManifest = res.ok ? ((await res.json()).sheets || {}) : {};
  } catch (_) {
    lbOwnedSheetManifest = {};
  }
  return lbOwnedSheetManifest;
}

function lbOwnedSheetFileFromManifest(manifest, name) {
  if (!name) return null;
  if (manifest[name]) return manifest[name];
  const stripped = name.replace(/\s*\(.*?\)\s*$/, '').trim();
  if (manifest[stripped]) return manifest[stripped];
  const safe = name.replace(/[<>:"/\\|?*]/g, '_').trim();
  return manifest[safe] || null;
}

async function lbOwnedOpenSheet(rowId) {
  const row = lbOwnedRows.find(r => r.id === rowId);
  const name = row?.unit?.Name || row?.displayName || '';
  if (!name) return;
  const manifest = await lbOwnedLoadSheetManifest();
  const file = lbOwnedSheetFileFromManifest(manifest, name);
  if (file) {
    const pdfBase = 'https://battletech-sheets.cjhapril.workers.dev/';
    window.open(pdfBase + encodeURIComponent(file), '_blank');
    return;
  }
  const MORDEL = 'https://mordel.net/tro.php?a=v&fltr=qf.000.Name~Contains~';
  window.open(MORDEL + encodeURIComponent(name), '_blank');
}

function lbOwnedDeleteRow(rowId) {
  const row = lbOwnedRows.find(r => r.id === rowId);
  if (!row) return;
  if (!confirm(`Delete ${row.displayName} from this owned-units list?`)) return;
  lbOwnedRows = lbOwnedRows.filter(r => r.id !== rowId);
  lbOwnedRefreshFactionFilter();
  lbOwnedRender();
  const status = document.getElementById('lb-owned-status');
  if (status) status.textContent = `${row.displayName} deleted from the local owned-units list.`;
}

function lbOwnedDeleteSelected() {
  const selected = lbOwnedRows.filter(r => r.selected);
  if (!selected.length) { alert('Select units to delete first.'); return; }
  if (!confirm(`Delete ${selected.length} selected unit${selected.length !== 1 ? 's' : ''} from this owned-units list?`)) return;
  const ids = new Set(selected.map(r => r.id));
  lbOwnedRows = lbOwnedRows.filter(r => !ids.has(r.id));
  lbOwnedRefreshFactionFilter();
  lbOwnedRender();
  const status = document.getElementById('lb-owned-status');
  if (status) status.textContent = `${selected.length} selected unit${selected.length !== 1 ? 's' : ''} deleted from the local owned-units list.`;
}

function lbOwnedSendToBuilder() {
  const selected = lbOwnedRows.filter(r => r.selected && r.unit).map(r => r.unit);
  if (!selected.length) { alert('Select matched owned units first.'); return; }
  const room = 500 - sbForce.length;
  selected.slice(0, Math.max(0, room)).forEach(u => {
    if (sbForce.some(f => f.unit.Id === u.Id)) return;
    sbForce.push({ unit: u, skill: 4 });
  });
  lbSwitchMode('skirmish');
  sbRenderForce();
  sbRenderBrowse();
  const status = document.getElementById('sb-status');
  if (status) {
    status.textContent = `${selected.length} selected owned unit${selected.length !== 1 ? 's' : ''} added to the Tournament Force. Choose a formation type above and click Build Formation.`;
    status.className = 'lb-status';
  }
  document.getElementById('lb-mode-skirmish')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function lbAssignToTypes(pool, typeKeys, upl) {
  const remaining = [...pool];
  const lances = [];
  for (const key of typeKeys) {
    if (remaining.length === 0) break;
    const scored = remaining.map(u => ({ u, score: lbSpecialScore(u, key) }))
                            .sort((a, b) => b.score - a.score);
    const picks = scored.slice(0, upl).map(x => x.u);
    lances.push(picks);
    picks.forEach(u => { const i = remaining.indexOf(u); if (i !== -1) remaining.splice(i, 1); });
  }
  return { lances, remaining };
}

// ── Organizes the current Tournament Force (sbForce) into lances using the
// shared formation engine (lbAssignToTypes / lbRenderLanceOutput). ──────────
function sbBuildFormation() {
  const fKey    = lbFTypeEl().value;
  const specKey = lbSTypeEl().value;
  const fDef    = LB_FORMATIONS[fKey];
  if (!fDef) return;
  if (!sbForce.length) { alert('Add units to your Tournament Force first.'); return; }

  const isClan  = lbFormationIsClan();
  const facId   = lbFFactionEl()?.value || '';
  let available = sbForce.map(f => f.unit);

  // Faction tech filter: Clans don't field IS-only mechs; IS factions don't field Clan-only mechs
  const techFiltered = [];
  if (isClan) {
    available = available.filter(u => {
      const tech = u.Technology?.Name || '';
      if (tech === 'Inner Sphere') { techFiltered.push(u.Name); return false; }
      return true;
    });
  } else if (facId) {
    available = available.filter(u => {
      const tech = u.Technology?.Name || '';
      if (tech === 'Clan') { techFiltered.push(u.Name); return false; }
      return true;
    });
  }

  const typeKeys = Array(fDef.lances).fill(specKey);
  const { lances, remaining } = lbAssignToTypes(available, typeKeys, fDef.unitsPerLance);

  lbCurrentLances  = lances.map(l => [...l]);
  lbLanceTypes     = typeKeys.slice();
  lbFormationDirty = false;
  lbCmdState       = {};
  lbUnitBonuses    = {};

  lbRenderLanceOutput(fDef, [], remaining, techFiltered);
}

function lbRenderLanceOutput(fDef, unresolved, remaining, techFiltered) {
  techFiltered = techFiltered || [];
  const lances  = lbCurrentLances;
  const totalPV = lances.flat().reduce((s, u) => s + (u.BFPointValue||0), 0);
  const supply  = Math.ceil(totalPV * 0.1);

  let html = `
  <div id="lb-replan-bar" class="lb-replan-bar" style="${lbFormationDirty?'display:flex':'display:none'}">
    <button class="lb-replan-btn" onclick="lbReplanLances()">⟳ Replan Lances</button>
    <span class="lb-changed-note">Changes made — replan to re-optimize lance assignments</span>
  </div>
  <div class="lb-formation-block">
    <div class="lb-formation-header">
      <span class="lb-formation-title">${fDef.name}</span>
      <span class="lb-formation-meta">
        ${lances.length} ${lbGroupWord(lbFormationIsClan(), lances.length)} &nbsp;·&nbsp;
        Total PV: <span style="color:var(--accent)" id="lb-total-pv">${totalPV}</span> &nbsp;·&nbsp;
        Supply: <span style="color:var(--green)" id="lb-total-sp">${supply}</span>
        &nbsp;·&nbsp; <button class="lb-btn-sm" onclick="lbPrintLances()" style="padding:2px 10px">🖨 Print</button>
        &nbsp; <button class="lb-btn-sm" onclick="lbDownloadCards()" style="padding:2px 10px">📇 Cards</button>
        &nbsp; <button class="lb-btn-sm" onclick="lbOpenSheets()" style="padding:2px 10px">📋 Sheets</button>
      </span>
    </div>
    <div class="lb-lances-grid">`;

  lances.forEach((units, li) => {
    html += lbRenderLanceBlock(units, li, lbLanceTypes[li] || '');
  });

  html += `</div></div>`;

  if (techFiltered && techFiltered.length > 0) {
    html += `<div class="lb-unresolved" style="margin-top:10px;color:var(--red)">
      ⚠ Wrong tech excluded for ${lbFormationFactionName()}: ${techFiltered.join(', ')}</div>`;
  }
  if (unresolved && unresolved.length > 0) {
    html += `<div class="lb-unresolved" style="margin-top:10px">
      ⚠ Units not found in MUL (excluded): ${unresolved.join(', ')}</div>`;
  }
  if (remaining && remaining.length > 0) {
    html += `<div class="lb-unresolved" style="margin-top:6px;color:var(--text3)">
      ${remaining.length} unit${remaining.length!==1?'s':''} in pool not used by this formation size.</div>`;
  }

  document.getElementById(lbFOutId()).innerHTML = html;
  // Apply skill multipliers after render (skill selects now exist in DOM)
  lbCurrentLances.forEach((_, li) => lbSkillChanged(li));
  lbUpdateTotalPV();
}

function lbPrintLances() {
  const fKey = lbFTypeEl().value;
  const fDef = LB_FORMATIONS[fKey] || {};
  const totalPV = lbCurrentLances.reduce((s, _, li) => s + lbGetAdjLancePV(li), 0);

  let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Lance Formation</title>
  <style>
    body { font-family:Arial,sans-serif; font-size:11px; color:#000; margin:20px; }
    h1 { font-size:18px; margin-bottom:2px; }
    .meta { font-size:11px; color:#555; margin-bottom:16px; }
    .lances { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:14px; }
    .lance { border:1px solid #999; border-radius:4px; page-break-inside:avoid; }
    .lance-hdr { background:#ddd; padding:6px 10px; font-weight:700; display:flex; justify-content:space-between; border-radius:4px 4px 0 0; }
    .unit { border-top:1px solid #ddd; padding:6px 10px; }
    .unit-name { font-weight:700; font-size:12px; }
    .unit-meta { font-size:10px; color:#555; }
    .unit-abil { font-size:10px; color:#006; margin-top:1px; }
    .unit-bonus { font-size:10px; color:#a60; font-weight:700; margin-top:2px; }
    .unit-bonus-desc { font-size:9px; color:#777; }
    .pips { font-size:12px; letter-spacing:2px; margin-top:4px; line-height:1.6; word-break:break-all; }
    .pips-lbl { font-size:10px; font-weight:700; color:#333; display:inline-block; width:18px; }
    .lance-stats { padding:5px 10px; background:#f5f5f5; font-size:10px; color:#555; border-top:1px solid #ddd; }
    .lance-abilities { padding:5px 10px; background:#fffbe6; font-size:10px; border-top:1px solid #ddd; }
    .lw-abil { color:#a60; font-weight:700; }
    .lw-desc { color:#666; font-size:9px; }
    @media print { body { margin:10px; } }
  </style></head><body>
  <h1>${fDef.name || 'Formation'}</h1>
  <div class="meta">Total PV: ${totalPV} &nbsp;·&nbsp; Supply Points: ${Math.ceil(totalPV*0.1)}</div>
  <div class="lances">`;

  lbCurrentLances.forEach((units, li) => {
    const lancePV  = lbGetAdjLancePV(li);
    const rawPV    = units.reduce((s,u)=>s+(u.BFPointValue||0),0);
    const lanceType = lbLanceTypes[li] || '';
    const typeLabel = lanceType && LB_SPECIAL_TYPES[lanceType] ? LB_SPECIAL_TYPES[lanceType].name : 'Standard';
    const skillEl  = document.getElementById(`lb-skill-${li}`);
    const skill    = skillEl ? parseInt(skillEl.value) : 4;
    const mult     = LB_SKILL_MULT[skill] ?? 1.0;
    const skillTxt = skillEl ? skillEl.options[skillEl.selectedIndex].text : '';
    const totS = units.reduce((s,u)=>s+(parseInt(u.BFDamageShort)||0),0);
    const totM = units.reduce((s,u)=>s+(parseInt(u.BFDamageMedium)||0),0);
    const totL = units.reduce((s,u)=>s+(parseInt(u.BFDamageLong)||0),0);
    const avgTMM = units.length ? Math.round(units.reduce((s,u)=>s+lbCalcTMM(u),0)/units.length) : 0;
    const lanceWide = (LB_TYPE_ABILITIES[lanceType] || {}).lanceWide || [];

    const pvLabel = skill === 4 ? `${rawPV} PV` : `${lancePV} PV (×${mult.toFixed(2)})`;
    const isClanPrintCsv = lbFormationIsClan();
    html += `<div class="lance">
      <div class="lance-hdr"><span>${lbGroupLabel(isClanPrintCsv, li)} — ${typeLabel}</span><span>${pvLabel}</span></div>`;

    units.forEach((u, si) => {
      const bonus  = lbUnitBonuses[`${li}-${si}`] || '';
      const isCmd  = `${li}-${si}` in lbCmdState;
      const abil   = (u.BFAbilities || '').trim();
      const armor  = parseInt(u.BFArmor)||0;
      const intr   = parseInt(u.BFStructure)||0;
      const dmgStr = `${u.BFDamageShort??'–'}/${u.BFDamageMedium??'–'}/${u.BFDamageLong??'–'}`;
      html += `<div class="unit">
        <div class="unit-name">${isCmd?'★ ':''}${u.Name}${isCmd?' (CMD)':''}</div>
        <div class="unit-meta">${LB_SZ[u.BFSize||0]} · ${u.Tonnage||'?'}t · ${u.Role?.Name||'—'} · MV ${u.BFMove||'?'} · TMM ${lbCalcTMM(u)} · ${u.BFPointValue||'?'} PV</div>
        <div class="unit-meta">Dmg S/M/L: ${dmgStr} · Armor: ${armor} · IS: ${intr}</div>
        ${abil ? `<div class="unit-abil">${abil}</div>` : ''}
        ${bonus ? `<div class="unit-bonus">★ ${bonus}</div><div class="unit-bonus-desc">${LB_ABILITY_DESC[bonus]||''}</div>` : ''}
        <div class="pips"><span class="pips-lbl">A:</span> ${'○'.repeat(Math.min(armor,30))}${armor>30?` (+${armor-30})`:''}  [${armor}]</div>
        <div class="pips"><span class="pips-lbl">IS:</span> ${'○'.repeat(Math.min(intr,15))}${intr>15?` (+${intr-15})`:''}  [${intr}]</div>
      </div>`;
    });

    if (lanceWide.length) {
      html += `<div class="lance-abilities">`;
      lanceWide.forEach(a => {
        html += `<div><span class="lw-abil">★ ${a}</span> <span class="lw-desc">${LB_ABILITY_DESC[a]||''}</span></div>`;
      });
      html += `</div>`;
    }
    html += `<div class="lance-stats">Dmg S${totS} M${totM} L${totL} · Avg TMM: ${avgTMM} · ${skillTxt}</div></div>`;

  });

  html += `</div></body></html>`;
  const w = window.open('','_blank');
  if (w) { w.document.write(html); w.document.close(); setTimeout(()=>w.print(),400); }
}

function lbDownloadCards() {
  const units = lbCurrentLances.flat().filter(u => u && u.Id);
  if (!units.length) return;
  const fKey    = lbFTypeEl().value;
  const fDef    = LB_FORMATIONS[fKey] || {};
  const totalPV = lbCurrentLances.reduce((s, _, li) => s + lbGetAdjLancePV(li), 0);
  const MUL_CARD = 'https://masterunitlist.azurewebsites.net/Unit/Card/';

  let cardRows = '';
  lbCurrentLances.forEach((lUnits, li) => {
    const lanceType  = lbLanceTypes[li] || '';
    const typeLabel  = lanceType && LB_SPECIAL_TYPES[lanceType]
      ? LB_SPECIAL_TYPES[lanceType].name : 'Standard';
    const lancePV    = lbGetAdjLancePV(li);
    const skillEl    = document.getElementById(`lb-skill-${li}`);
    const skillTxt   = skillEl ? skillEl.options[skillEl.selectedIndex].text : '';
    const lanceWide  = (LB_TYPE_ABILITIES[lanceType] || {}).lanceWide || [];

    // Lance/Star header row
    const isClanDlCards = lbFormationIsClan();
    cardRows += `<div class="lance-hdr">
      <span class="lhdr-title">${lbGroupLabel(isClanDlCards, li)} — ${typeLabel}</span>
      <span class="lhdr-meta">${lancePV} PV &nbsp;·&nbsp; ${skillTxt}</span>
    </div>`;

    // Lance-wide abilities strip (shown once per lance, above the cards)
    if (lanceWide.length) {
      cardRows += `<div class="lance-wide">`;
      lanceWide.forEach(a => {
        cardRows += `<div class="lw-row"><span class="lw-tag">★ LANCE</span> <strong>${a}</strong> — <span class="lw-desc">${LB_ABILITY_DESC[a]||''}</span></div>`;
      });
      cardRows += `</div>`;
    }

    cardRows += `<div class="card-row">`;
    lUnits.forEach((u, si) => {
      if (!u || !u.Id) return;
      const isCmd   = `${li}-${si}` in lbCmdState;
      const bonus   = lbUnitBonuses[`${li}-${si}`] || '';
      const safeName = u.Name.replace(/'/g, "\\'");

      // Build annotation strip below the card image
      let annot = '';
      if (isCmd) {
        annot += `<div class="annot-cmd">★ LANCE COMMANDER</div>`;
      }
      if (bonus) {
        annot += `<div class="annot-bonus">
          <span class="annot-bonus-name">★ ${bonus}</span>
          <span class="annot-bonus-desc">${LB_ABILITY_DESC[bonus]||''}</span>
        </div>`;
      }

      cardRows += `<div class="card-wrap${isCmd?' card-cmd':''}">
        <img src="${MUL_CARD}${u.Id}" alt="${u.Name}"
          onerror="this.style.outline='2px dashed #c00';this.style.padding='8px';this.alt='Card unavailable: ${safeName}'"
        >
        ${annot}
        <div class="card-name">${isCmd ? '★ ' : ''}${u.Name}</div>
        <div class="pilot-info">
          <input class="p-name" type="text" placeholder="Pilot name">
          <div class="p-skills">
            <span>GU <input class="p-skill" type="number" min="1" max="8" value="4" title="Gunnery Skill"></span>
            <span>PI <input class="p-skill" type="number" min="1" max="8" value="5" title="Piloting Skill"></span>
          </div>
        </div>
      </div>`;
    });
    cardRows += `</div>`;
  });

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
  <title>${fDef.name||'Formation'} — Alpha Strike Cards</title>
  <style>
    * { box-sizing:border-box; margin:0; padding:0; }
    body { font-family:Arial,sans-serif; background:#fff; }
    .header { padding:12px 16px; border-bottom:2px solid #333; margin-bottom:10px; }
    .header h1 { font-size:16px; }
    .header p  { font-size:11px; color:#555; margin-top:3px; }

    /* Lance section */
    .lance-hdr { display:flex; justify-content:space-between; align-items:baseline;
                 padding:8px 14px 4px; margin-top:14px;
                 border-top:2px solid #333; background:#f0f0f0; }
    .lhdr-title { font-size:13px; font-weight:700; }
    .lhdr-meta  { font-size:10px; color:#555; }

    /* Lance-wide abilities */
    .lance-wide { padding:4px 14px 6px; background:#fffbe6; border-bottom:1px solid #e8d96a; }
    .lw-row  { font-size:10px; color:#555; padding:1px 0; }
    .lw-tag  { background:#d4a800; color:#fff; font-size:8px; font-weight:700;
               border-radius:2px; padding:1px 4px; margin-right:4px; letter-spacing:.04em; }
    .lw-desc { color:#777; }

    /* Card grid */
    .card-row  { display:flex; flex-wrap:wrap; gap:12px; padding:10px 14px 6px; }
    .card-wrap { display:flex; flex-direction:column; align-items:center; width:340px; }
    .card-wrap img { width:340px; height:auto; border:1px solid #bbb; border-radius:4px; display:block; }
    .card-wrap.card-cmd img { border:2px solid #c8a800; box-shadow:0 0 6px rgba(200,168,0,.5); }

    /* Annotation strip below each card */
    .annot-cmd { width:340px; background:#1a1400; color:#ffd700;
                 font-size:10px; font-weight:700; letter-spacing:.08em;
                 text-align:center; padding:3px 6px; border-radius:0 0 3px 3px;
                 margin-top:-2px; }
    .annot-bonus { width:340px; background:#2a1800; color:#ffb347;
                   font-size:10px; padding:3px 8px; border-radius:3px; margin-top:3px;
                   display:flex; flex-direction:column; gap:1px; }
    .annot-bonus-name { font-weight:700; }
    .annot-bonus-desc { font-size:9px; color:#cc8833; }

    .card-name { font-size:9px; color:#888; margin-top:3px; text-align:center; }
    .pilot-info { width:340px; margin-top:6px; }
    .p-name  { width:100%; border:1px solid #aaa; border-radius:2px; padding:3px 5px; font-size:11px; }
    .p-skills { display:flex; gap:10px; margin-top:3px; font-size:11px; font-weight:700; align-items:center; }
    .p-skill { width:36px; border:1px solid #aaa; border-radius:2px; padding:2px 3px;
               text-align:center; font-size:11px; font-weight:700; }

    @media print {
      body { margin:0; }
      .lance-hdr { page-break-before:auto; }
      .card-wrap { page-break-inside:avoid; }
    }
  </style></head><body>
  <div class="header">
    <h1>${fDef.name||'Formation'} — Alpha Strike Cards</h1>
    <p>Total PV: ${totalPV} &nbsp;·&nbsp; Supply Points: ${Math.ceil(totalPV*0.1)} &nbsp;·&nbsp; ${units.length} units &nbsp;·&nbsp; Use <strong>Print → Save as PDF</strong> to download</p>
  </div>
  ${cardRows}
  </body></html>`;

  const w = window.open('', '_blank');
  if (w) {
    w.document.write(html);
    w.document.close();
    w.addEventListener('load', () => setTimeout(() => w.print(), 500));
  }
}

// ── Shared sheets-popup builder ─────────────────────────────────────────────
// config: { lances, lanceTypes, cmdState, unitBonuses, fDef, totalPV,
//           isClan, getLancePV(li), getSkillText(li) }
async function lbOpenSheetsCore(cfg) {
  const MORDEL     = 'https://mordel.net/tro.php?a=v&fltr=qf.000.Name~Contains~';
  const sheetsBase = new URL('sheets/', LB_SHARED_BASE).href;
  const pdfBase    = 'https://battletech-sheets.cjhapril.workers.dev/';
  const { lances, lanceTypes, cmdState, unitBonuses,
          fDef, totalPV, isClan, getLancePV, getSkillText } = cfg;
  // Per-unit Alpha Strike skill (= record sheet Gunnery; Piloting is always
  // Gunnery + 1 per the house rule). Callers that track skill per lance or
  // per unit supply this; default is a Regular 4/5 pilot.
  const getUnitSkill = cfg.getUnitSkill || (() => 4);

  let manifest = {};
  try {
    const res = await fetch(sheetsBase + 'manifest.json');
    if (res.ok) manifest = (await res.json()).sheets || {};
  } catch (_) {}

  // Self-drawn record-sheet data (built offline by build_sheet_data.py from
  // the MegaMek MTF database + SSW BV backfill). Optional — if it fails to
  // load, every unit simply falls back to the embedded-PDF path below.
  let mechData = {}, mechAliases = {}, mechByMul = {};
  try {
    const res = await fetch(sheetsBase + 'mech-data.json');
    if (res.ok) {
      const j = await res.json();
      mechData = j.mechs || {};
      mechAliases = j.aliases || {};
      mechByMul = j.byMul || {};
    }
  } catch (_) {}

  // Faithful silhouette + circle-coordinate data. Optional — rsSheetSVG falls
  // back to pip-cluster diagrams if it fails to load.
  if (!rsSilData) {
    try {
      const res = await fetch(sheetsBase + 'rs-silhouettes.json');
      if (res.ok) rsSilData = await res.json();
    } catch (_) {}
  }

  function sheetFile(name) {
    if (!name) return null;
    if (manifest[name]) return manifest[name];
    const stripped = name.replace(/\s*\(.*?\)\s*$/, '').trim();
    if (manifest[stripped]) return manifest[stripped];
    const safe = name.replace(/[<>:"/\\|?*]/g, '_').trim();
    return manifest[safe] || null;
  }

  // Match a unit to its self-drawn-sheet record: exact MUL id first (the
  // MTF data carries each unit's MUL id), then normalized name, then the
  // IS-name alias (e.g. "Thor Prime" -> "Summoner Prime"). Rendering is
  // still biped-only; quads/tripods stay on the PDF path for now.
  function sheetMechData(u) {
    let key = mechByMul[String(u.Id || '')] || null;
    if (!key) {
      const n = sbNorm(u.Name);
      key = mechData[n] ? n : mechAliases[n];
    }
    const rec = key ? mechData[key] : null;
    if (!rec) return null;
    return /biped/i.test(rec.motive || 'Biped') ? rec : null;
  }

  let lanceSections = '';
  let embeddedCount = 0;
  const pdfUrls   = [];
  const unitNames = [];

  lances.forEach((lUnits, li) => {
    const lanceType = lanceTypes[li] || '';
    const typeLabel = lanceType && LB_SPECIAL_TYPES[lanceType]
      ? LB_SPECIAL_TYPES[lanceType].name : 'Standard';
    const lancePV  = getLancePV(li);
    const skillTxt = getSkillText(li);

    lanceSections += `<div class="lance-hdr">
      ${lbGroupLabel(isClan, li)} — ${typeLabel}
      <span class="lance-meta">${lancePV} PV · ${skillTxt}</span>
    </div>`;

    lUnits.forEach((u, si) => {
      if (!u) return;
      unitNames.push(u.Name);
      const isCmd  = !!cmdState[`${li}-${si}`];
      const bonus  = unitBonuses[`${li}-${si}`] || '';
      const file   = sheetFile(u.Name);
      const sz     = LB_SZ[u.BFSize||0] || '?';

      const metaBar = `<div class="unit-meta-bar${isCmd?' unit-cmd':''}">
        ${isCmd ? '<span class="cmd-badge">★ CMD</span>' : ''}
        <strong>${u.Name}</strong>
        <span class="unit-meta">${sz} · ${u.Tonnage||'?'}t · ${u.Role?.Name||'—'} · MV ${u.BFMove||'?'} · ${u.BFPointValue||'?'} PV · Intro: ${u.DateIntroduced||'?'}</span>
        ${bonus ? `<span class="unit-bonus">★ ${bonus} — ${LB_ABILITY_DESC[bonus]||''}</span>` : ''}
      </div>`;

      const mechRec = sheetMechData(u);
      if (mechRec) {
        // Self-drawn SVG record sheet (no PDF dependency, no calibration hack).
        embeddedCount++;
        lanceSections += `<div class="sheet-block sheet-drawn">
          ${metaBar}
          <div class="drawn-note">✍️ Self-drawn record sheet (from MegaMek data)${file ? ' · scanned PDF also available below' : ''}</div>
          <div class="drawn-sheet">${(() => { const g = getUnitSkill(li, si); return rsSheetSVG(mechRec, { gunnery: g, piloting: g + 1 }); })()}</div>
          <div class="sheet-actions">
            <button class="btn-print-one" onclick="printDrawnSheet(this)">🖨 Print / Save PDF (this sheet)</button>
            ${file ? `
            <a href="${pdfBase + encodeURIComponent(file)}" download="${file}" class="btn-dl">⬇ Download scanned PDF</a>
            <a href="${pdfBase + encodeURIComponent(file)}" target="_blank" class="btn-open">↗ Open scanned PDF</a>` : ''}
          </div>
        </div>`;
      } else if (file) {
        embeddedCount++;
        const pdfUrl = pdfBase + encodeURIComponent(file);
        pdfUrls.push(pdfUrl);
        const pdfIdx = pdfUrls.length - 1;
        lanceSections += `<div class="sheet-block">
          ${metaBar}
          <div class="pilot-bar" data-pdf-index="${pdfIdx}">
            <span class="pilot-label">Pilot</span>
            <input class="pilot-name" type="text" placeholder="Pilot name">
            <span class="pilot-label">GU</span>
            <input class="pilot-skill" type="number" min="1" max="8" value="4" title="Gunnery Skill (1=best, 8=worst)">
            <span class="pilot-label">PI</span>
            <input class="pilot-skill" type="number" min="1" max="8" value="5" title="Piloting Skill (1=best, 8=worst)">
            <span class="pilot-hint">Edit before printing</span>
          </div>
          <object class="sheet-embed" data="${pdfUrl}" type="application/pdf">
            <p class="pdf-fallback">PDF could not be displayed inline.
              <a href="${pdfUrl}" target="_blank">Open sheet ↗</a></p>
          </object>
          <div class="sheet-actions">
            <a href="${pdfUrl}" download="${file}" class="btn-dl">⬇ Download sheet</a>
            <a href="${pdfUrl}" target="_blank" class="btn-open">↗ Open in new tab</a>
          </div>
        </div>`;
      } else {
        const search  = encodeURIComponent(u.Name);
        const chassis = encodeURIComponent((u.Name||'').split(' ')[0]);
        lanceSections += `<div class="sheet-block missing">
          ${metaBar}
          <div class="missing-msg">⚠️ No local sheet found for <strong>${u.Name}</strong>. Find it on mordel.net:</div>
          <div class="mordel-links">
            <a href="${MORDEL}${search}" target="_blank" class="btn-mordel">📋 Search mordel for "${u.Name}"</a>
            <a href="${MORDEL}${chassis}" target="_blank" class="btn-chassis">Browse all ${(u.Name||'').split(' ')[0]}s →</a>
          </div>
        </div>`;
      }
    });
  });

  const totalUnits  = lances.flat().filter(Boolean).length;
  const missingCount = totalUnits - embeddedCount;
  const statusLine = embeddedCount === 0
    ? `<div class="status-bar missing-all">No sheets found for these units — they may not be in the PDF library yet.</div>`
    : missingCount > 0
      ? `<div class="status-bar partial">${embeddedCount} sheet${embeddedCount!==1?'s':''} embedded · ${missingCount} missing (shown with mordel links)</div>`
      : `<div class="status-bar ok">All ${embeddedCount} sheet${embeddedCount!==1?'s':''} embedded ✓</div>`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
  <title>${fDef.name||'Formation'} — Classic BT Sheets</title>
  <style>
    * { box-sizing:border-box; margin:0; padding:0; }
    body { font-family:Arial,sans-serif; font-size:12px; background:#eee; }
    .page-header { background:#1a1a2e; color:#fff; padding:12px 20px; display:flex; justify-content:space-between; align-items:baseline; }
    .page-header h1 { font-size:16px; }
    .page-header p  { font-size:10px; color:#aaa; }
    .status-bar { padding:8px 20px; font-size:11px; font-weight:600; }
    .status-bar.ok          { background:#1b5e20; color:#a5d6a7; }
    .status-bar.partial     { background:#e65100; color:#ffe0b2; }
    .status-bar.missing-all { background:#b71c1c; color:#ffcdd2; }
    .status-bar code { background:rgba(255,255,255,.15); padding:1px 5px; border-radius:3px; font-size:10px; }
    .lance-hdr { background:#333; color:#fff; padding:7px 16px; font-size:12px; font-weight:700;
                 display:flex; justify-content:space-between; margin-top:10px; }
    .lance-meta { font-weight:400; color:#aaa; font-size:10px; }
    .sheet-block { background:#fff; margin:0; padding:0; }
    .sheet-block + .sheet-block { border-top:2px solid #ccc; }
    .unit-meta-bar { padding:7px 16px; background:#f5f5f5; border-bottom:1px solid #ddd;
                     display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
    .unit-meta-bar.unit-cmd { background:#fffbea; border-left:4px solid #d4a800; }
    .cmd-badge { background:#d4a800; color:#000; font-size:9px; font-weight:700;
                 padding:1px 5px; border-radius:2px; letter-spacing:.06em; }
    .unit-meta { font-size:10px; color:#777; }
    .unit-bonus { font-size:10px; color:#b05000; font-weight:600; }
    .sheet-embed { display:block; width:100%; height:1056px; border:none; }
    .pdf-fallback { padding:20px; color:#888; font-size:11px; }
    .sheet-actions { display:flex; gap:8px; padding:8px 16px; background:#f9f9f9; border-top:1px solid #eee; }
    .btn-dl, .btn-open { font-size:11px; font-weight:700; padding:5px 14px; border-radius:4px;
                         text-decoration:none; white-space:nowrap; }
    .btn-dl   { background:#1565c0; color:#fff; }
    .btn-open { background:#eee; color:#333; border:1px solid #ccc; }
    .drawn-note { padding:6px 16px; background:#eef7ee; border-bottom:1px solid #cfe6cf;
                  font-size:11px; font-weight:600; color:#2e7d32; }
    .drawn-sheet { padding:12px 16px; background:#fff; }
    .drawn-sheet svg { max-width:820px; margin:0 auto; }
    .missing { background:#fff8f8; }
    .missing-msg { padding:12px 16px 4px; font-size:11px; color:#666; }
    .missing-msg code { background:#eee; padding:1px 5px; border-radius:3px; }
    .mordel-links { display:flex; gap:8px; padding:8px 16px 12px; flex-wrap:wrap; }
    .btn-mordel { background:#1565c0; color:#fff; text-decoration:none; font-size:11px;
                  font-weight:700; padding:5px 12px; border-radius:4px; white-space:nowrap; }
    .btn-chassis { background:#666; color:#fff; text-decoration:none; font-size:10px;
                   padding:5px 10px; border-radius:4px; white-space:nowrap; }
    @media print {
      .page-header, .status-bar, .sheet-actions, .lance-hdr, .print-bar,
      .drawn-note, .unit-meta-bar, .missing, .pilot-bar { display:none; }
      .sheet-block { page-break-after:always; }
      .sheet-embed { height:100vh; }
      .drawn-sheet { padding:0; }
      .drawn-sheet svg { max-width:100%; }
      body { background:#fff; }
    }
    .btn-print-one { background:#2e7d32; color:#fff; border:none; padding:5px 12px; border-radius:4px;
                     font-size:11px; font-weight:700; cursor:pointer; }
    .print-bar { background:#0d1117; padding:8px 20px; display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
    .print-bar span { color:#aaa; font-size:11px; }
    .btn-print-all  { background:#2e7d32; color:#fff; border:none; padding:7px 18px; border-radius:5px;
                      font-size:12px; font-weight:700; cursor:pointer; }
    .btn-print-all:disabled { background:#555; cursor:default; }
    .btn-dl-all     { background:#1565c0; color:#fff; border:none; padding:7px 18px; border-radius:5px;
                      font-size:12px; font-weight:700; cursor:pointer; }
    .btn-dl-all:disabled { background:#555; cursor:default; }
    .btn-export-list { background:#4a148c; color:#fff; border:none; padding:7px 18px; border-radius:5px;
                       font-size:12px; font-weight:700; cursor:pointer; }
    .btn-calibrate   { background:#e65100; color:#fff; border:none; padding:7px 18px; border-radius:5px;
                       font-size:12px; font-weight:700; cursor:pointer; }
    #merge-progress { font-size:11px; color:#8bc34a; font-style:italic; }
    .pilot-bar { display:flex; align-items:center; gap:8px; padding:5px 16px;
                 background:#eef2ff; border-bottom:1px solid #c5cae9; flex-wrap:wrap; }
    .pilot-label { font-size:10px; font-weight:700; color:#3949ab; }
    .pilot-name  { border:1px solid #9fa8da; border-radius:3px; padding:2px 6px;
                   font-size:11px; width:180px; }
    .pilot-skill { border:1px solid #9fa8da; border-radius:3px; padding:2px 4px;
                   font-size:11px; width:38px; text-align:center; font-weight:700; }
    .pilot-hint  { font-size:9px; color:#888; margin-left:4px; }
  </style>
  <script src="https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js"><\/script>
  <script>
    window._pdfUrls   = ${JSON.stringify(pdfUrls)};
    window._unitNames = ${JSON.stringify(unitNames)};
    if (window.pdfjsLib) {
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
    }
    // Print just one self-drawn sheet: open a bare window holding only that
    // sheet's SVG and invoke the browser print dialog (where "Save as PDF"
    // gives a single-unit PDF without any page chrome).
    function printDrawnSheet(btn) {
      const block = btn.closest('.sheet-block');
      const svg   = block.querySelector('.drawn-sheet').innerHTML;
      const name  = (block.querySelector('.unit-meta-bar strong') || {}).textContent || 'Record Sheet';
      const pw = window.open('', '_blank');
      if (!pw) return;
      pw.document.write('<html><head><title>' + name + ' — Record Sheet</title>'
        + '<style>@page{size:letter;margin:6mm} html,body{margin:0;padding:0} svg{width:100%;height:auto;display:block}</style>'
        + '</head><body>' + svg + '</body></html>');
      pw.document.close();
      setTimeout(() => { pw.focus(); pw.print(); }, 350);
    }
  <\/script>
  <script src="${new URL('sheets-popup.js', LB_SHARED_BASE).href}?v=${Date.now()}"><\/script>
  </head><body>
  <div class="page-header">
    <h1>${fDef.name||'Formation'} — Classic BattleTech Record Sheets</h1>
    <p>Total PV: ${totalPV} · Supply: ${Math.ceil(totalPV*0.1)}</p>
  </div>
  <div class="print-bar">
    <button class="btn-print-all" onclick="window.print()">🖨 Print (browser)</button>
    <button id="btn-print-all" class="btn-dl-all" onclick="mergeAllPdfs('print')" ${pdfUrls.length===0?'disabled':''}>🖨 Print PDF Sheets</button>
    <button id="btn-dl-all"    class="btn-dl-all"    onclick="mergeAllPdfs('download')" ${pdfUrls.length===0?'disabled':''}>📥 Download PDFs as One</button>
    <button class="btn-export-list" onclick="exportUnitList()" title="Download unit names for merge_sheets.py">📋 Export Unit List</button>
    ${pdfUrls.length ? `<button class="btn-calibrate" onclick="calibratePilotPos()" title="Click to set exact pilot data field positions on your sheets">🎯 Calibrate Positions</button>` : ''}
    <span id="merge-progress"></span>
    <span style="margin-left:auto">${unitNames.length} unit${unitNames.length!==1?'s':''} · ${embeddedCount} sheet${embeddedCount!==1?'s':''} found</span>
  </div>
  ${statusLine}
  ${lanceSections}
  </body></html>`;

  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); }
}

async function lbOpenSheets() {
  if (!lbCurrentLances.flat().filter(Boolean).length) return;
  const fKey   = lbFTypeEl().value;
  const fDef   = LB_FORMATIONS[fKey] || {};
  const isClan = lbFormationIsClan();
  await lbOpenSheetsCore({
    lances:      lbCurrentLances,
    lanceTypes:  lbLanceTypes,
    cmdState:    lbCmdState,
    unitBonuses: lbUnitBonuses,
    fDef,
    totalPV:     lbCurrentLances.reduce((s,_,li)=>s+lbGetAdjLancePV(li),0),
    isClan,
    getLancePV:  li => lbGetAdjLancePV(li),
    getSkillText: li => {
      const el = document.getElementById(`lb-skill-${li}`);
      return el ? el.options[el.selectedIndex].text : '';
    },
    // Lance Builder skill selects are 0=Legendary..4=Green; AS gunnery is
    // that index + 1 (Legendary 1 .. Green 5).
    getUnitSkill: li => {
      const el = document.getElementById(`lb-skill-${li}`);
      return el ? parseInt(el.value, 10) + 1 : 4;
    },
  });
}

function lbCalcTMM(u) {
  // BFTMM from QuickList is unreliable (often 0) — always derive from BFMove
  const mv = lbGetMV(u);
  if (mv <= 4)  return 0;
  if (mv <= 8)  return 1;
  if (mv <= 12) return 2;
  if (mv <= 18) return 3;
  if (mv <= 24) return 4;
  return 5;
}

function lbMakePips(count, cls) {
  return Array.from({length: count}, (_, i) =>
    `<span class="lb-pip ${cls}" onclick="this.classList.toggle('hit')" title="${cls==='armor'?'Armor':'IS'} ${i+1}"></span>`
  ).join('');
}

function lbRenderUnitRow(u, li, si, specKey, lanceTaken) {
  const sz      = u.BFSize||0;
  const dmg     = `${u.BFDamageShort??'–'}/${u.BFDamageMedium??'–'}/${u.BFDamageLong??'–'}`;
  const chassis = lbGetChassis(u.Name);
  const armor   = parseInt(u.BFArmor)     || 0;
  const intr    = parseInt(u.BFStructure) || 0;
  const abil    = (u.BFAbilities || '').trim();
  const key     = `${li}-${si}`;
  const isCmd   = key in lbCmdState;
  const taken   = lanceTaken || new Set();

  // Per-unit ability picker (Command Lance only — each unit picks one unique ability)
  const typeInfo    = LB_TYPE_ABILITIES[specKey] || {};
  const perUnitList = typeInfo.perUnit || [];
  const unitBonus   = lbUnitBonuses[key] || '';
  let perUnitHtml   = '';
  if (perUnitList.length > 0) {
    const available = perUnitList.filter(a => !taken.has(a) || a === unitBonus);
    const bOpts = available.map(a =>
      `<option value="${a}" ${a===unitBonus?'selected':''}>${a}</option>`).join('');
    perUnitHtml = `<div class="lb-cmd-pick">
      <select onchange="lbSetUnitBonus(${li},${si},this.value)">
        <option value="">— pick ability —</option>${bOpts}
      </select>
    </div>`;
    if (unitBonus) perUnitHtml +=
      `<div class="lb-unit-abil" style="color:var(--orange)">★ ${unitBonus}</div>` +
      `<div class="lb-unit-abil" style="color:var(--text3)">${LB_ABILITY_DESC[unitBonus]||''}</div>`;
  }

  return `<div class="lb-unit-row" id="lb-unit-${li}-${si}"
    draggable="true"
    ondragstart="lbDragStart(event,${li},${si})"
    ondragend="lbDragEnd(event)"
    ondragover="lbDragOver(event,${li},${si})"
    ondrop="lbDrop(event,${li},${si})">
    <span class="lb-rpill ${LB_SZ_CLS[sz]}" style="flex-shrink:0;align-self:flex-start;margin-top:2px">${LB_SZ[sz]||'?'}</span>
    <div class="lb-unit-name" style="min-width:0;flex:1">
      ${isCmd ? '<span class="lb-cmd-badge">★ CMD</span>' : ''}
      <select class="lb-unit-select"
        data-lance="${li}" data-slot="${si}" data-chassis="${chassis}"
        onchange="lbSwapUnit(${li},${si},this)"
        onfocus="lbLoadVariants(this)">
        <option value="${u.Id??u.Name}">${u.Name}</option>
        <option value="__loading__" disabled>⏳ Loading variants…</option>
      </select>
      <small>${u.Tonnage||'?'}t · ${u.Role?u.Role.Name:'—'} · MV ${u.BFMove||'?'} · TMM ${lbCalcTMM(u)} · ${u.DateIntroduced||'?'}</small>
      ${abil ? `<div class="lb-unit-abil">${abil}</div>` : ''}
      ${perUnitHtml}
      <div class="lb-pip-track" title="Armor: ${armor}">
        <span class="lb-pip-label">A</span>${lbMakePips(armor,'armor')}
      </div>
      <div class="lb-pip-track" title="IS: ${intr}">
        <span class="lb-pip-label">I</span>${lbMakePips(intr,'internal')}
      </div>
    </div>
    <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0">
      <span class="lb-unit-dmg">${u.BFPointValue||'?'}pv<br>S${dmg}</span>
      <button class="lb-cmd-btn${isCmd?' active':''}" onclick="lbToggleCmd(${li},${si})" title="Toggle lance commander">
        ${isCmd ? '★ CMD' : '☆ CMD'}
      </button>
      ${u.Id ? `<a href="https://masterunitlist.azurewebsites.net/Unit/Card/${u.Id}" target="_blank" class="lb-card-link" title="View Alpha Strike card">🃏</a>` : ''}
    </div>
  </div>`;
}

function lbLanceStatsHtml(units, li) {
  const totS   = units.reduce((s,u) => s + (parseInt(u.BFDamageShort) ||0), 0);
  const totM   = units.reduce((s,u) => s + (parseInt(u.BFDamageMedium)||0), 0);
  const totL   = units.reduce((s,u) => s + (parseInt(u.BFDamageLong)  ||0), 0);
  const avgTMM = units.length
    ? Math.round(units.reduce((s,u) => s + lbCalcTMM(u), 0) / units.length)
    : '—';
  const curType   = lbLanceTypes[li] || '';
  const factionId = lbFFactionEl()?.value || '';
  let typeOpts = '';
  let lastFac = false;
  lbGetFactionTypeOpts(factionId, units, curType).forEach(({ v, t, disabled, faction }) => {
    if (faction && !lastFac) {
      typeOpts += `<optgroup label="— ${lbFormationFactionName()} —">`;
      lastFac = true;
    }
    // Keep current selection even if no longer qualifies; hide others that don't qualify
    if (disabled && v !== curType) return;
    const noLongerQual = v && v === curType && disabled;
    typeOpts += `<option value="${v}" ${v===curType?'selected':''}>${t}${noLongerQual?' (no longer qualifies)':''}</option>`;
  });
  if (lastFac) typeOpts += `</optgroup>`;
  return `<div class="lb-lance-stats" id="lb-stats-${li}">
    <div class="lb-lstat-group">
      <span class="lb-lstat-title">Lance Damage</span>
      <span class="lb-lstat-dmg" id="lb-ldmg-${li}">
        <span class="lb-dmg-lbl">S</span><span class="lb-dmg-num">${totS}</span>
        <span class="lb-dmg-lbl">M</span><span class="lb-dmg-num">${totM}</span>
        <span class="lb-dmg-lbl">L</span><span class="lb-dmg-num">${totL}</span>
      </span>
    </div>
    <div class="lb-lstat-group">
      <span class="lb-lstat-title">Avg TMM</span>
      <span class="lb-lstat-val" id="lb-tmm-${li}">${avgTMM}</span>
    </div>
    <div class="lb-lstat-group">
      <span class="lb-lstat-title">Lance Skill</span>
      <select class="lb-skill-sel" id="lb-skill-${li}" onchange="lbSkillChanged(${li})">
        <option value="0">Skill 0 — Legendary</option>
        <option value="1">Skill 1 — Elite</option>
        <option value="2">Skill 2 — Veteran</option>
        <option value="3" selected>Skill 3 — Regular</option>
        <option value="4">Skill 4 — Green</option>
      </select>
    </div>
    <div class="lb-lstat-group" style="grid-column:1/-1">
      <span class="lb-lstat-title">Lance Type</span>
      <select class="lb-lance-type-sel" id="lb-lance-type-${li}" onchange="lbLanceTypeChanged(${li},this.value)">
        ${typeOpts}
      </select>
      ${(LB_TYPE_ABILITIES[curType]?.lanceWide || []).map(a =>
        `<div style="margin-top:4px">
          <span class="lb-unit-abil" style="color:var(--orange)">★ ${a}</span>
          <div class="lb-unit-abil">${LB_ABILITY_DESC[a]||''}</div>
        </div>`
      ).join('')}
    </div>
  </div>`;
}

function lbUpdateLanceStats(li) {
  const units  = lbCurrentLances[li];
  const totS   = units.reduce((s,u) => s + (parseInt(u.BFDamageShort) ||0), 0);
  const totM   = units.reduce((s,u) => s + (parseInt(u.BFDamageMedium)||0), 0);
  const totL   = units.reduce((s,u) => s + (parseInt(u.BFDamageLong)  ||0), 0);
  const avgTMM = units.length
    ? Math.round(units.reduce((s,u) => s + lbCalcTMM(u), 0) / units.length)
    : '—';
  const dmgEl = document.getElementById(`lb-ldmg-${li}`);
  const tmmEl = document.getElementById(`lb-tmm-${li}`);
  if (dmgEl) dmgEl.innerHTML =
    `<span class="lb-dmg-lbl">S</span><span class="lb-dmg-num">${totS}</span>` +
    `<span class="lb-dmg-lbl">M</span><span class="lb-dmg-num">${totM}</span>` +
    `<span class="lb-dmg-lbl">L</span><span class="lb-dmg-num">${totL}</span>`;
  if (tmmEl) tmmEl.textContent = avgTMM;
}

function lbRenderLanceBlock(units, li, specKey) {
  const lancePV = units.reduce((s, u) => s + (u.BFPointValue||0), 0);
  const counts  = [0,0,0,0,0];
  units.forEach(u => { const s=u.BFSize||0; if(s>=1&&s<=4) counts[s]++; });
  const compStr  = [1,2,3,4].filter(s=>counts[s]>0).map(s=>`${counts[s]}× ${LB_SZ[s]}`).join(' · ');
  const eligible = lbCheckLanceTypes(counts, units.length);

  const isClanBlock = lbFormationIsClan();
  let html = `<div class="lb-lance-block" id="lb-block-${li}">
    <div class="lb-lance-title">
      ${lbGroupLabel(isClanBlock, li)}
      <span class="lb-lance-pv" id="lb-lance-pv-${li}">${lancePV} PV</span>
    </div>`;

  const typeInfo = LB_TYPE_ABILITIES[specKey] || {};
  units.forEach((u, si) => {
    const taken = typeInfo.perUnit ? lbGetLanceTaken(li, si) : new Set();
    html += lbRenderUnitRow(u, li, si, specKey, taken);
  });

  html += lbLanceStatsHtml(units, li);
  html += `<div class="lb-lance-analysis" id="lb-analysis-${li}">${compStr} &nbsp;·&nbsp; ${eligible}</div>
  </div>`;
  return html;
}

async function lbLoadVariants(selectEl) {
  if (selectEl.dataset.loaded) return;
  selectEl.dataset.loaded = '1';
  const chassis   = selectEl.dataset.chassis;
  const currentId = selectEl.options[0].value;

  const varFaction  = lbFFactionEl()?.value || '';
  const varEraRange = null; // Skirmish's era filter already narrowed the catalog before the pool was built
  const cacheKey    = `${chassis}__${varFaction}__${varEraRange?.max||''}`;
  let variants = lbVariantsCache[cacheKey];
  if (!variants) {
    try {
      const params = new URLSearchParams({ Name: chassis });
      if (varFaction) params.set('Factions', varFaction);
      const res    = await fetch(`${MUL_API}?${params}`);
      const data   = await res.json();
      variants = (data.Units || data || []).filter(u => (u.BFSize||0) > 0);
      // Client-side filters: era and tech
      const varIsClan = lbIsClanFaction(varFaction);
      if (varEraRange) variants = variants.filter(u => (parseInt(u.DateIntroduced)||0) <= varEraRange.max);
      if (varFaction)  variants = variants.filter(u => {
        const tech = u.Technology?.Name || '';
        return varIsClan ? tech !== 'Inner Sphere' : tech !== 'Clan';
      });
    } catch(e) { variants = []; }
    lbVariantsCache[cacheKey] = variants;
  }

  // Remove loading placeholder
  selectEl.querySelectorAll('option[value="__loading__"]').forEach(o => o.remove());

  variants.forEach(v => {
    if (String(v.Id) === currentId || v.Name === selectEl.options[0].textContent) return;
    const opt       = document.createElement('option');
    opt.value       = String(v.Id);
    opt.textContent = `${v.Name} (${v.BFPointValue||'?'} PV)`;
    opt._unitData   = v;
    selectEl.appendChild(opt);
  });
  selectEl.value = currentId;
}

function lbSwapUnit(li, si, selectEl) {
  const opt = selectEl.options[selectEl.selectedIndex];
  if (!opt || opt.value === '__loading__' || !opt._unitData) return;
  const newUnit = opt._unitData;

  lbCurrentLances[li][si] = newUnit;
  lbFormationDirty = true;

  // Re-render the whole unit row so armor/IS pips update correctly
  const rowEl = document.getElementById(`lb-unit-${li}-${si}`);
  if (rowEl) {
    const sk = lbLanceTypes[li] || '';
    const typeInfoSw = LB_TYPE_ABILITIES[sk] || {};
    const takenSw = typeInfoSw.perUnit ? lbGetLanceTaken(li, si) : new Set();
    rowEl.outerHTML = lbRenderUnitRow(newUnit, li, si, sk, takenSw);
  }

  // Update lance PV (skill-adjusted) + formation totals
  lbSkillChanged(li);
  lbUpdateTotalPV();

  // Update lance damage totals + avg TMM
  lbUpdateLanceStats(li);

  // Update analysis row
  const counts = [0,0,0,0,0];
  lbCurrentLances[li].forEach(u => { const s=u.BFSize||0; if(s>=1&&s<=4) counts[s]++; });
  const compStr  = [1,2,3,4].filter(s=>counts[s]>0).map(s=>`${counts[s]}× ${LB_SZ[s]}`).join(' · ');
  const eligible = lbCheckLanceTypes(counts, lbCurrentLances[li].length);
  const anaEl = document.getElementById(`lb-analysis-${li}`);
  if (anaEl) anaEl.innerHTML = `${compStr} &nbsp;·&nbsp; ${eligible}`;

  // Show replan bar
  const bar = document.getElementById('lb-replan-bar');
  if (bar) bar.style.display = 'flex';
}

function lbReplanLances() {
  const fKey = lbFTypeEl().value;
  const fDef = LB_FORMATIONS[fKey];
  if (!fDef) return;

  // Read current per-lance types from the DOM
  lbLanceTypes = lbCurrentLances.map((_, li) => {
    const el = document.getElementById(`lb-lance-type-${li}`);
    return el ? el.value : '';
  });

  const pool = lbCurrentLances.flat();
  const { lances, remaining } = lbAssignToTypes(pool, lbLanceTypes, fDef.unitsPerLance);

  lbCurrentLances  = lances;
  lbVariantsCache  = {};
  lbFormationDirty = false;
  lbCmdState       = {};
  lbUnitBonuses    = {};
  lbRenderLanceOutput(fDef, [], remaining);
}

function lbLanceTypeChanged(li, val) {
  lbLanceTypes[li] = val;
  lbFormationDirty = true;
  const bar = document.getElementById('lb-replan-bar');
  if (bar) bar.style.display = 'flex';
  // Re-render the lance block so abilities + perUnit pickers update immediately
  const block = document.getElementById(`lb-block-${li}`);
  if (block) block.outerHTML = lbRenderLanceBlock(lbCurrentLances[li], li, val);
  lbSkillChanged(li);
}

/* ── Drag-and-drop ─────────────────────────────────────── */
function lbDragStart(e, li, si) {
  lbDragSrc = { li, si };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', `${li}-${si}`);
  setTimeout(() => {
    const el = document.getElementById(`lb-unit-${li}-${si}`);
    if (el) el.classList.add('lb-dragging');
  }, 0);
}

function lbDragEnd(e) {
  document.querySelectorAll('.lb-unit-row.lb-dragging, .lb-unit-row.lb-drag-over')
    .forEach(el => { el.classList.remove('lb-dragging'); el.classList.remove('lb-drag-over'); });
}

function lbDragOver(e, li, si) {
  e.preventDefault();
  if (!lbDragSrc || (lbDragSrc.li === li && lbDragSrc.si === si)) return;
  document.querySelectorAll('.lb-unit-row.lb-drag-over')
    .forEach(el => el.classList.remove('lb-drag-over'));
  const el = document.getElementById(`lb-unit-${li}-${si}`);
  if (el) el.classList.add('lb-drag-over');
}

function lbDrop(e, li, si) {
  e.preventDefault();
  const src = lbDragSrc;
  lbDragEnd(e);
  if (!src || (src.li === li && src.si === si)) return;

  // Swap units
  const tmp = lbCurrentLances[li][si];
  lbCurrentLances[li][si]       = lbCurrentLances[src.li][src.si];
  lbCurrentLances[src.li][src.si] = tmp;

  // Swap commander state and unit bonuses
  const kA = `${li}-${si}`, kB = `${src.li}-${src.si}`;
  const cmdA = lbCmdState[kA],    cmdB = lbCmdState[kB];
  const bonA = lbUnitBonuses[kA], bonB = lbUnitBonuses[kB];
  delete lbCmdState[kA];    delete lbCmdState[kB];
  delete lbUnitBonuses[kA]; delete lbUnitBonuses[kB];
  if (cmdA !== undefined) lbCmdState[kB]    = cmdA;
  if (cmdB !== undefined) lbCmdState[kA]    = cmdB;
  if (bonA !== undefined) lbUnitBonuses[kB] = bonA;
  if (bonB !== undefined) lbUnitBonuses[kA] = bonB;

  lbFormationDirty = true;

  // Re-render affected lance blocks in place
  [...new Set([li, src.li])].forEach(idx => {
    const block = document.getElementById(`lb-block-${idx}`);
    if (block) block.outerHTML = lbRenderLanceBlock(lbCurrentLances[idx], idx, lbLanceTypes[idx]||'');
  });

  const bar = document.getElementById('lb-replan-bar');
  if (bar) bar.style.display = 'flex';
}

/* ── Commander ─────────────────────────────────────────── */
function lbToggleCmd(li, si) {
  const key = `${li}-${si}`;
  if (key in lbCmdState) delete lbCmdState[key];
  else lbCmdState[key] = '';
  const block = document.getElementById(`lb-block-${li}`);
  if (block) block.outerHTML = lbRenderLanceBlock(lbCurrentLances[li], li, lbLanceTypes[li]||'');
}

function lbSetCmdAbility(li, si, ability) {
  lbCmdState[`${li}-${si}`] = ability;
}

function lbCheckLanceTypes(counts, total) {
  const results = [];
  if (counts[1] >= 2 && counts[3] === 0 && counts[4] === 0) results.push('Light Lance ✓');
  if (counts[2] >= 2 && counts[4] === 0)                     results.push('Medium Lance ✓');
  if (counts[3] >= 2)                                         results.push('Heavy Lance ✓');
  if (counts[4] >= 2 && counts[1] === 0)                     results.push('Assault Lance ✓');
  if ((counts[3]+counts[4]) >= Math.ceil(total/2))           results.push('Battle Lance ✓');
  return results.length > 0 ? results.join(' &nbsp; ') : '<span style="color:var(--text3)">Mixed</span>';
}
