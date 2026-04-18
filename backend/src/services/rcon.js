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

async function getTps(server) {
  try {
    const resp = await sendCommand(server, 'tps');
    const match = resp.match(/TPS from last 1m, 5m, 15m: ([\d.]+), ([\d.]+), ([\d.]+)/i)
      || resp.match(/([\d.]+),?\s*([\d.]+),?\s*([\d.]+)/);
    if (match) {
      return {
        tps1: parseFloat(match[1]),
        tps5: parseFloat(match[2]),
        tps15: parseFloat(match[3]),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch both player list and TPS in a single RCON connection.
 */
async function getServerStats(server) {
  try {
    const [listResp, tpsResp] = await sendCommands(server, ['list', 'tps']);

    let players = { online: 0, max: server.max_players };
    const listMatch = listResp?.match(/(\d+)\s+of\s+a\s+max\s+of\s+(\d+)/) || listResp?.match(/(\d+)\/(\d+)/);
    if (listMatch) players = { online: parseInt(listMatch[1]), max: parseInt(listMatch[2]) };

    let tps = null;
    const tpsMatch = tpsResp?.match(/TPS from last 1m, 5m, 15m: ([\d.]+), ([\d.]+), ([\d.]+)/i)
      || tpsResp?.match(/(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/);
    if (tpsMatch) tps = { tps1: parseFloat(tpsMatch[1]), tps5: parseFloat(tpsMatch[2]), tps15: parseFloat(tpsMatch[3]) };

    return { players, tps };
  } catch {
    return { players: { online: 0, max: server.max_players }, tps: null };
  }
}

module.exports = { sendCommand, sendCommands, getPlayerList, getTps, getServerStats };
