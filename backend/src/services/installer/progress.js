let io;
function setIo(ioInstance) { io = ioInstance; }
function getIo() { return io; }

// Fin d'installation : diffusée à tous les clients (l'interface envoie alors l'icône / le monde
// choisis au déploiement, même si l'utilisateur a quitté la page du serveur entre-temps)
const BROADCAST_EVENTS = new Set(['install:done', 'install:error']);

function emit(serverId, event, data) {
  if (!io) return;
  const target = BROADCAST_EVENTS.has(event) ? io : io.to(`server:${serverId}`);
  target.emit(event, { serverId, ...data });
}

function progress(serverId, step, message, percent) {
  emit(serverId, 'install:progress', { step, message, percent });
  console.log(`[Installer][${serverId.slice(0, 8)}] ${step}: ${message}`);
}

/**
 * Callback de progression d'un docker pull : n'émet qu'une ligne par couche,
 * au lieu d'une par événement "Downloading" (des centaines de lignes identiques).
 */
function pullProgress(serverId, step, label, percent) {
  const seen = new Set();
  return (evt) => {
    if (evt.status !== 'Downloading' || !evt.id || seen.has(evt.id)) return;
    seen.add(evt.id);
    progress(serverId, step, `${label}: ${evt.id}`, percent);
  };
}

module.exports = { setIo, getIo, emit, progress, pullProgress };
