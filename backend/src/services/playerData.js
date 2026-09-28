// Données de jeu d'un joueur lues dans le monde : statistiques vanilla, succès, et fichier joueur
// (vie, faim, XP, position, inventaire…). Deux dispositions existent :
//   ≥ 26.x : world/players/{stats,advancements,data}/<uuid>.*
//   avant  : world/{stats,advancements,playerdata}/<uuid>.*
const fs = require('fs');
const path = require('path');
const { parseNbt, T } = require('./nbt');

const DATA_PATH = process.env.DATA_PATH || '/data';
const serverDir = id => path.join(DATA_PATH, 'servers', id, 'server');

function levelName(dir) {
  try {
    const m = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8').match(/^level-name=(.*)$/m);
    if (m && m[1].trim()) return m[1].trim();
  } catch {}
  return 'world';
}

function worldDir(serverId) {
  const dir = serverDir(serverId);
  return path.join(dir, levelName(dir));
}

/** UUID d'un joueur : base Craftarr, sinon usercache.json du serveur. */
function uuidFor(serverId, username, knownUuid) {
  if (knownUuid) return knownUuid;
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(serverDir(serverId), 'usercache.json'), 'utf8'));
    const hit = cache.find(e => (e.name || '').toLowerCase() === username.toLowerCase());
    if (hit?.uuid) return hit.uuid;
  } catch {}
  return null;
}

function findFile(serverId, uuid, kind) {
  const w = worldDir(serverId);
  const candidates = {
    stats: [path.join(w, 'players', 'stats', `${uuid}.json`), path.join(w, 'stats', `${uuid}.json`)],
    advancements: [path.join(w, 'players', 'advancements', `${uuid}.json`), path.join(w, 'advancements', `${uuid}.json`)],
    data: [path.join(w, 'players', 'data', `${uuid}.dat`), path.join(w, 'playerdata', `${uuid}.dat`)],
  }[kind];
  return candidates.find(f => fs.existsSync(f)) || null;
}

// ─── Statistiques ─────────────────────────────────────────────
const DISTANCES = ['walk', 'sprint', 'crouch', 'swim', 'walk_under_water', 'walk_on_water', 'climb', 'fly', 'aviate', 'fall', 'boat', 'minecart', 'horse', 'pig', 'strider', 'happy_ghast'];

function top(obj, n = 10) {
  return Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(([id, value]) => ({ id, value }));
}
const sum = obj => Object.values(obj || {}).reduce((a, b) => a + b, 0);

function readStats(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Très vieux format (< 1.13) : clés à plat « stat.xxx » — non géré
  const s = raw.stats || {};
  const c = s['minecraft:custom'] || {};
  const g = k => c[`minecraft:${k}`] || 0;
  const distances = {};
  for (const d of DISTANCES) { const v = g(`${d}_one_cm`); if (v) distances[d] = Math.round(v / 100); }
  return {
    playTimeSeconds: Math.round((g('play_time') || g('play_one_minute')) / 20),
    deaths: g('deaths'),
    mobKills: g('mob_kills'),
    playerKills: g('player_kills'),
    damageDealt: Math.round(g('damage_dealt') / 10),   // en cœurs ×2 (points de vie)
    damageTaken: Math.round(g('damage_taken') / 10),
    jumps: g('jump'),
    sleeps: g('sleep_in_bed'),
    timeSinceDeathSeconds: Math.round(g('time_since_death') / 20),
    fishCaught: g('fish_caught'),
    animalsBred: g('animals_bred'),
    trades: g('traded_with_villager'),
    enchants: g('enchant_item'),
    chestsOpened: g('open_chest') + g('open_barrel') + g('open_shulker_box'),
    distanceMeters: Object.values(distances).reduce((a, b) => a + b, 0) - (distances.fall || 0),
    distances,
    blocksMined: sum(s['minecraft:mined']),
    itemsCrafted: sum(s['minecraft:crafted']),
    mobsKilledTotal: sum(s['minecraft:killed']),
    topMined: top(s['minecraft:mined']),
    topKilled: top(s['minecraft:killed']),
    topKilledBy: top(s['minecraft:killed_by'], 5),
    topCrafted: top(s['minecraft:crafted']),
    topUsed: top(s['minecraft:used']),
    topPickedUp: top(s['minecraft:picked_up']),
    // Stats de mods (lootr, waystones…) et vanilla restantes, pour la vue détaillée
    custom: Object.entries(c).filter(([k]) => !k.startsWith('minecraft:') || !/_one_cm$/.test(k))
      .map(([id, value]) => ({ id, value })).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

// ─── Succès ───────────────────────────────────────────────────
function readAdvancements(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const done = [];
  let inProgress = 0;
  for (const [id, v] of Object.entries(raw)) {
    if (id === 'DataVersion' || id.includes(':recipes/') || !v || typeof v !== 'object') continue;
    if (v.done) {
      const dates = Object.values(v.criteria || {}).map(d => Date.parse(String(d).replace(' +0000', 'Z').replace(' ', 'T'))).filter(Number.isFinite);
      done.push({ id, doneAt: dates.length ? new Date(Math.max(...dates)).toISOString() : null });
    } else inProgress++;
  }
  done.sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || ''));
  return { doneCount: done.length, inProgress, done };
}

// ─── Fichier joueur (NBT) ─────────────────────────────────────
const get = (compound, key) => compound?.find?.(([k]) => k === key)?.[1];
const val = (compound, key) => get(compound, key)?.value;
const num = v => (typeof v === 'bigint' ? Number(v) : v);

/** Texte d'un composant JSON/NBT (nom personnalisé) : text + extra, translate ignoré. */
function componentText(tag) {
  if (!tag) return null;
  if (tag.type === T.STRING) {
    const s = tag.value;
    try { return componentText(jsonToTag(JSON.parse(s))) ?? s; } catch { return s; }
  }
  if (tag.type === T.COMPOUND) {
    let out = val(tag.value, 'text') || '';
    const extra = get(tag.value, 'extra');
    if (extra?.type === T.LIST) {
      for (const it of extra.value.items) out += componentText({ type: extra.value.elType, value: it }) || '';
    }
    return out || null;
  }
  if (tag.type === T.LIST) return tag.value.items.map(it => componentText({ type: tag.value.elType, value: it }) || '').join('') || null;
  return null;
}
function jsonToTag(j) {
  if (typeof j === 'string') return { type: T.STRING, value: j };
  if (Array.isArray(j)) return { type: T.LIST, value: { elType: T.COMPOUND, items: j.map(x => jsonToTag(typeof x === 'string' ? { text: x } : x).value) } };
  return { type: T.COMPOUND, value: Object.entries(j).map(([k, v]) => [k, typeof v === 'string' ? { type: T.STRING, value: v } : jsonToTag(v)]) };
}

function readItem(itemCompound) {
  if (!itemCompound) return null;
  const id = val(itemCompound, 'id');
  if (!id) return null;
  const count = num(val(itemCompound, 'count') ?? val(itemCompound, 'Count') ?? 1);
  const components = val(itemCompound, 'components'); // ≥ 1.20.5
  const legacyTag = val(itemCompound, 'tag');         // < 1.20.5
  const name = componentText(get(components, 'minecraft:custom_name'))
    || componentText(get(val(legacyTag, 'display'), 'Name'));
  const enchants = [];
  const ench = val(components, 'minecraft:enchantments');
  const levels = val(ench, 'levels') || ench; // 1.20.5 : { levels: {…} }, 26.x : { id: niveau }
  if (Array.isArray(levels)) for (const [eid, t] of levels) if (t.type !== T.COMPOUND) enchants.push({ id: eid, level: num(t.value) });
  const legacyEnch = get(legacyTag, 'Enchantments');
  if (legacyEnch?.type === T.LIST) {
    for (const e of legacyEnch.value.items) enchants.push({ id: val(e, 'id'), level: num(val(e, 'lvl')) });
  }
  const damage = num(val(components, 'minecraft:damage') ?? val(legacyTag, 'Damage') ?? 0);
  return { id, count, name, enchants, damage: damage || undefined };
}

function readItemList(tag) {
  if (tag?.type !== T.LIST) return [];
  return tag.value.items.map(it => {
    const item = readItem(it);
    if (!item) return null;
    return { slot: num(val(it, 'Slot') ?? 0), ...item };
  }).filter(Boolean);
}

function readPlayerFile(file) {
  const { root } = parseNbt(fs.readFileSync(file));
  const r = root.value;
  const pos = val(r, 'Pos');
  const equipment = val(r, 'equipment'); // ≥ 1.21.5
  const equip = {};
  if (equipment) for (const slot of ['head', 'chest', 'legs', 'feet', 'offhand', 'body']) {
    const it = readItem(val(equipment, slot));
    if (it) equip[slot] = it;
  }
  const inventory = readItemList(get(r, 'Inventory'));
  // Avant 1.21.5, armure (100-103) et main gauche (-106) sont dans Inventory
  const legacySlots = { 100: 'feet', 101: 'legs', 102: 'chest', 103: 'head', [-106]: 'offhand' };
  for (const it of inventory) if (legacySlots[it.slot] && !equip[legacySlots[it.slot]]) equip[legacySlots[it.slot]] = it;
  const death = val(r, 'LastDeathLocation');
  const deathPos = val(death, 'pos');
  const attrs = get(r, 'attributes');
  let maxHealth = 20;
  if (attrs?.type === T.LIST) {
    for (const a of attrs.value.items) {
      const id = val(a, 'id') || val(a, 'Name');
      if (!/max_health$/.test(id || '')) continue;
      maxHealth = num(val(a, 'base') ?? val(a, 'Base') ?? 20);
      // Bonus « add_value » (équipement, mods) — les multiplicateurs sont ignorés
      const mods = get(a.value ? { value: a } : a, 'modifiers') || get(a, 'modifiers') || get(a, 'Modifiers');
      if (mods?.type === T.LIST) for (const m of mods.value.items) {
        const op = val(m, 'operation') ?? val(m, 'Operation');
        if (op === 'add_value' || op === 0) maxHealth += num(val(m, 'amount') ?? val(m, 'Amount') ?? 0);
      }
    }
  }
  return {
    health: num(val(r, 'Health')),
    maxHealth: Math.max(maxHealth, Math.ceil(num(val(r, 'Health')) || 0)),
    absorption: num(val(r, 'AbsorptionAmount') || 0),
    food: num(val(r, 'foodLevel')),
    saturation: num(val(r, 'foodSaturationLevel')),
    xpLevel: num(val(r, 'XpLevel')),
    xpProgress: num(val(r, 'XpP')),
    xpTotal: num(val(r, 'XpTotal')),
    score: num(val(r, 'Score')),
    gameMode: num(val(r, 'playerGameType')),
    dimension: val(r, 'Dimension') || null,
    pos: pos?.items ? pos.items.map(v => Math.round(num(v) * 10) / 10) : null,
    lastDeath: deathPos ? { pos: deathPos.map(num), dimension: val(death, 'dimension') } : null,
    selectedSlot: num(val(r, 'SelectedItemSlot') ?? 0),
    inventory: inventory.filter(it => it.slot >= 0 && it.slot < 36),
    equipment: equip,
    enderChest: readItemList(get(r, 'EnderItems')),
    fileMtime: fs.statSync(file).mtimeMs,
  };
}

/** Tout ce que le monde sait d'un joueur ; chaque partie est facultative (fichier absent, format inconnu). */
function readPlayerWorldData(serverId, username, knownUuid) {
  const uuid = uuidFor(serverId, username, knownUuid);
  const out = { uuid, stats: null, advancements: null, player: null, errors: [] };
  if (!uuid) return out;
  const tryRead = (kind, fn, key) => {
    const f = findFile(serverId, uuid, kind);
    if (!f) return;
    try { out[key] = fn(f); } catch (err) { out.errors.push(`${kind}: ${err.message}`); }
  };
  tryRead('stats', readStats, 'stats');
  tryRead('advancements', readAdvancements, 'advancements');
  tryRead('data', readPlayerFile, 'player');
  return out;
}

module.exports = { readPlayerWorldData, uuidFor, worldDir, _internals: { readStats, readAdvancements, readPlayerFile, readItem, componentText } };
