import { useEffect } from 'react';
import { io } from 'socket.io-client';
import { useAuthStore } from '../store';

let globalSocket = null;

export function getSocket() {
  // Ne jamais recréer le socket s'il existe déjà — Socket.IO gère la reconnexion automatiquement.
  // Recréer pendant une reconnexion tuerait les listeners de Layout.jsx et casserait le store.
  if (!globalSocket) {
    const token = localStorage.getItem('mcm_token');
    globalSocket = io('/', {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
  }
  return globalSocket;
}

// Permet de forcer une réinitialisation du socket (ex: logout)
export function resetSocket() {
  if (globalSocket) {
    globalSocket.disconnect();
    globalSocket = null;
  }
}

export function useSocket() {
  const token = useAuthStore(s => s.token);
  useEffect(() => {
    if (!token) return;
    getSocket();
  }, [token]);
}

export function useServerSocket(serverId, containerId, handlers = {}) {
  const token = useAuthStore(s => s.token);

  useEffect(() => {
    if (!token || !serverId) return;
    const socket = getSocket();

    function subscribe() {
      socket.emit('logs:subscribe', { serverId });
    }

    socket.on('connect', subscribe);

    if (socket.connected) {
      subscribe();
    }

    const entries = Object.entries(handlers);
    entries.forEach(([event, handler]) => socket.on(event, handler));

    return () => {
      socket.off('connect', subscribe);
      entries.forEach(([event, handler]) => socket.off(event, handler));
    };
  // Re-run quand containerId change (juste après installation d'un nouveau container)
  }, [token, serverId, containerId]); // eslint-disable-line react-hooks/exhaustive-deps
}
