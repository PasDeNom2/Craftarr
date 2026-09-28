// Découpe une ligne de log Minecraft en morceaux affichables.
//
// Formats rencontrés :
//   [20:04:37] [Server thread/INFO] [minecraft/DedicatedServer]: Done (11.207s)!   (Forge / NeoForge)
//   [20:04:37] [Server thread/INFO]: Done (11.207s)!                                 (vanilla / Paper)
//   [20:04:37 INFO]: Done                                                            (Paper ancien format)
//   2026-09-27T16:04:14.640Z  WARN  mc-server-runner  ...                            (itzg)
//   [init] Running as uid=1000 ...                                                    (itzg)
//   > list -> There are 0 of a max of 20 players online                              (commande RCON de Craftarr)
//   [Craftarr] ⚠ Diagnostic : ...                                                     (diagnostic Craftarr)

const RE_FORGE = /^\[(\d{2}:\d{2}:\d{2})\] \[([^\]/]+)\/([A-Z]+)\](?: \[([^\]]+)\])?:\s?(.*)$/;
const RE_PAPER_OLD = /^\[(\d{2}:\d{2}:\d{2}) ([A-Z]+)\]:\s?(.*)$/;
const RE_ITZG = /^(\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})[^\s]*)\s+([A-Z]+)\s+(\S+)\s+(.*)$/;
// Horodatage ISO en tête de ligne (log4j de certains mods, itzg) : « 2026-09-27T20:04:25.85Z Server thread ERROR … »
const RE_ISO = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})\S*\s+(.*)$/;
// Lignes de stacktrace Java — Docker retire souvent la tabulation de tête, donc indentation facultative
const RE_STACK = /^\s*at [^\s(]+\(.*\)|^\s*\.\.\. \d+ more\s*$|^\s*Caused by: |^\s*Suppressed: /;
const RE_JOIN = /(\w{2,16}) (joined the game|logged in with entity id)/;
const RE_LEAVE = /(\w{2,16}) (left the game|lost connection)/;
// « [Not Secure] » : préfixe des messages non signés depuis Minecraft 1.19
const RE_CHAT = /^(?:\[Not Secure\] )?<([^>]{2,16})> (.*)$/;

export const LEVELS = ['INFO', 'WARN', 'ERROR'];

export function parseLine(raw) {
  const line = raw.replace(/\r$/, '');

  if (line.startsWith('[Craftarr]')) {
    return { raw: line, kind: 'craftarr', level: 'WARN', message: line.replace(/^\[Craftarr\]\s*/, '') };
  }
  if (line.startsWith('> ')) {
    const [cmd, ...rest] = line.slice(2).split(' -> ');
    return { raw: line, kind: 'command', level: 'INFO', command: cmd, message: rest.join(' -> ') };
  }
  if (RE_STACK.test(line)) {
    return { raw: line, kind: 'stack', level: 'ERROR', message: line };
  }

  let time = null, thread = null, level = 'INFO', logger = null, message = line;
  let m = line.match(RE_FORGE);
  if (m) {
    [, time, thread, level, logger, message] = m;
  } else if ((m = line.match(RE_PAPER_OLD))) {
    [, time, level, message] = m;
  } else if ((m = line.match(RE_ITZG)) && /^(INFO|WARN|ERROR|DEBUG|FATAL)$/.test(m[3])) {
    time = m[2]; level = m[3]; logger = m[4]; message = m[5];
  } else if ((m = line.match(RE_ISO))) {
    time = m[1];
    message = m[2];
    const lv = message.match(/\b(ERROR|WARN|INFO|FATAL)\b/);
    level = lv ? lv[1] : (/exception|error/i.test(message) ? 'ERROR' : 'INFO');
  } else if (/exception|error|fatal/i.test(line) && !/0 errors?/i.test(line)) {
    level = 'ERROR';
  } else if (/\bwarn(ing)?\b/i.test(line)) {
    level = 'WARN';
  }
  if (level === 'FATAL' || level === 'SEVERE') level = 'ERROR';
  if (level === 'WARNING') level = 'WARN';
  if (!LEVELS.includes(level)) level = level === 'DEBUG' || level === 'TRACE' ? 'DEBUG' : 'INFO';

  let kind = 'log';
  let player = null;
  let chat = null;
  const joinM = message.match(RE_JOIN);
  const leaveM = message.match(RE_LEAVE);
  const chatM = message.match(RE_CHAT);
  if (chatM) { kind = 'chat'; player = chatM[1]; chat = chatM[2]; }
  else if (joinM && /joined the game/.test(message)) { kind = 'join'; player = joinM[1]; }
  else if (leaveM && /left the game/.test(message)) { kind = 'leave'; player = leaveM[1]; }

  // Le nom court du logger suffit : "minecraft/DedicatedServer" → "DedicatedServer"
  const loggerShort = logger ? logger.split(/[/.]/).pop() : null;

  return { raw: line, kind, time, thread, level, logger: loggerShort, message, player, chat };
}

/**
 * Regroupe les lignes de stacktrace sous la ligne d'erreur qui les précède :
 * une exception de 60 lignes devient une seule entrée repliable.
 */
export function groupEntries(parsed) {
  const out = [];
  for (const entry of parsed) {
    const prev = out[out.length - 1];
    if (entry.kind === 'stack' && prev) {
      (prev.trace = prev.trace || []).push(entry.raw);
      if (prev.level !== 'ERROR') prev.level = prev.level === 'WARN' ? 'WARN' : 'ERROR';
    } else {
      out.push({ ...entry });
    }
  }
  return out;
}
