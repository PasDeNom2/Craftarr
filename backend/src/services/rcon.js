const net = require('net');

const RCON_PACKET_TYPE = { AUTH: 3, COMMAND: 2, RESPONSE: 0 };

function buildPacket(id, type, body) {
  const bodyBuf = Buffer.from(body + '\x00', 'utf8');
  const size = 4 + 4 + bodyBuf.length + 1;
  const buf = Buffer.alloc(size + 4);
  buf.writeInt32LE(size, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  bodyBuf.copy(buf, 12);
  buf.writeInt8(0, 12 + bodyBuf.length);
  return buf;
}

function parsePacket(buf) {
  if (buf.length < 14) return null;
  const size = buf.readInt32LE(0);
  if (buf.length < size + 4) return null;
  const id = buf.readInt32LE(4);
  const type = buf.readInt32LE(8);
  const body = buf.slice(12, size + 4 - 2).toString('utf8');
  return { id, type, body, totalLength: size + 4 };
}

/**
 * Opens a single RCON session, authenticates once, sends all commands, then closes.
 * Returns an array of response strings in the same order as commands.
 */
// Port RCON interne du container (toujours 25575 côté Docker).
// server.rcon_port est le port hôte mappé — invalide sur le réseau Docker interne.
const RCON_INTERNAL_PORT = 25575;

async function sendCommands(server, commands, timeoutMs = 8000) {
  const host = server.container_name || 'localhost';
  const port = RCON_INTERNAL_PORT;
  const password = server.rcon_password;

  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let buffer = Buffer.alloc(0);
    let authenticated = false;
    let cmdIndex = 0;
    const responses = [];
    const pending = new Map(); // packetId -> resolve fn

    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error('RCON timeout'));
    }, timeoutMs);

    client.connect(port, host, () => {
      client.write(buildPacket(1, RCON_PACKET_TYPE.AUTH, password));
    });

    client.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 14) {
        const packet = parsePacket(buffer);
        if (!packet) break;
        buffer = buffer.slice(packet.totalLength);

        if (!authenticated) {
          if (packet.id === -1) {
            clearTimeout(timer);
            client.destroy();
            reject(new Error('RCON authentication failed'));
            return;
          }
          authenticated = true;
          // Send all commands at once, each with a unique id starting at 10
          for (let i = 0; i < commands.length; i++) {
            client.write(buildPacket(10 + i, RCON_PACKET_TYPE.COMMAND, commands[i]));
          }
        } else {
          const idx = packet.id - 10;
          if (idx >= 0 && idx < commands.length) {
            responses[idx] = packet.body;
            cmdIndex++;
            if (cmdIndex >= commands.length) {
              clearTimeout(timer);
              client.destroy();
              resolve(responses);
            }
          }
        }
      }
    });

    client.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function sendCommand(server, command, timeoutMs = 8000) {
  const results = await sendCommands(server, [command], timeoutMs);
  return results[0] || '';
}

async function getPlayerList(server) {
  try {
    const resp = await sendCommand(server, 'list');
    // Format moderne : "There are 2 of a max of 20 players online: Steve, Alex"
    // Format ancien  : "2/20 players online"
    const countMatch = resp.match(/(\d+)\s+of\s+a\s+max\s+of\s+(\d+)/) || resp.match(/(\d+)\/(\d+)/);
    const namesMatch = resp.match(/online:\s*(.+)/i);
    const names = namesMatch ? namesMatch[1].split(',').map(n => n.trim()).filter(Boolean) : [];
    if (countMatch) {
      return { online: parseInt(countMatch[1]), max: parseInt(countMatch[2]), names };
    }
    return { online: 0, max: server.max_players, names: [] };
  } catch {
    return { online: 0, max: server.max_players, names: [] };
  }
}

/**
 * Commande TPS selon le serveur : "tps" n'existe que sur Paper/Spigot/Purpur.
 * NeoForge / Forge ont leur propre commande ; vanilla/Fabric/Quilt (1.20.3+) ont "tick query".
 */
function tpsCommandFor(server) {
  const loader = (server.loader_type || '').toLowerCase();
  if (loader === 'neoforge') return 'neoforge tps';
  if (loader === 'forge') return 'forge tps';
  if (['vanilla', 'fabric', 'quilt'].includes(loader)) return 'tick query';
  return 'tps';
}

/** Extrait { tps1, tps5, tps15 } de la réponse (tps5/tps15 = null si le serveur ne les donne pas). */
function parseTps(resp) {
  if (!resp) return null;
  const clean = resp.replace(/§./g, '');
  // Paper/Spigot : "TPS from last 1m, 5m, 15m: 20.0, 19.98, 19.95"
  const paper = clean.match(/TPS from last 1m, 5m, 15m:\s*\*?([\d.]+),\s*\*?([\d.]+),\s*\*?([\d.]+)/i);
  if (paper) return { tps1: parseFloat(paper[1]), tps5: parseFloat(paper[2]), tps15: parseFloat(paper[3]) };
  // NeoForge : "Overall: 20.000 TPS (17.452 ms/tick)"  |  Forge : "Overall: Mean tick time: 3.2 ms. Mean TPS: 20.000"
  const overall = clean.match(/Overall\s*:[^\n]*?([\d.]+)\s*TPS/i) || clean.match(/Overall\s*:[^\n]*?Mean TPS:\s*([\d.]+)/i);
  if (overall) return { tps1: parseFloat(overall[1]), tps5: null, tps15: null };
  // Vanilla "tick query" : "Average time per tick: 3.2ms (Target: 50.0ms)" → TPS = min(20, 1000 / mspt)
  const mspt = clean.match(/Average time per tick:\s*([\d.]+)\s*ms/i);
  if (mspt) {
    const ms = parseFloat(mspt[1]);
    return { tps1: Math.round(Math.min(20, ms > 0 ? 1000 / ms : 20) * 10) / 10, tps5: null, tps15: null };
  }
  return null;
}

/**
 * Fetch both player list and TPS in a single RCON connection.
 */
async function getServerStats(server) {
  try {
    const [listResp, tpsResp] = await sendCommands(server, ['list', tpsCommandFor(server)]);

    let players = { online: 0, max: server.max_players };
    const listMatch = listResp?.match(/(\d+)\s+of\s+a\s+max\s+of\s+(\d+)/) || listResp?.match(/(\d+)\/(\d+)/);
    if (listMatch) players = { online: parseInt(listMatch[1]), max: parseInt(listMatch[2]) };

    return { players, tps: parseTps(tpsResp) };
  } catch {
    return { players: { online: 0, max: server.max_players }, tps: null };
  }
}

module.exports = { sendCommand, sendCommands, getPlayerList, getServerStats, parseTps, tpsCommandFor };
