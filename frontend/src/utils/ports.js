// Ports Minecraft : même logique que findFreePort côté backend (port de jeu + port RCON = port + 10).

/** Premier port libre à partir de 25565. */
export function nextFreePort(servers = []) {
  const used = new Set(servers.flatMap(s => [s.port, s.rcon_port]));
  let port = 25565;
  while (used.has(port) || used.has(port + 10)) port++;
  return port;
}

/** Serveur qui utilise déjà ce port (en ignorant excludeId), ou null. */
export function portTakenBy(servers = [], port, excludeId = null) {
  return servers.find(s => s.id !== excludeId && (s.port === port || s.rcon_port === port)) || null;
}
