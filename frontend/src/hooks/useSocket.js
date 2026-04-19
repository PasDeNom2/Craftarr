import { useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { useAuthStore } from '../store';

let globalSocket = null;

export function getSocket() {
  const token = localStorage.getItem('mcm_token');
  if (!globalSocket || !globalSocket.connected) {
    if (globalSocket) globalSocket.disconnect();
    globalSocket = io('/', {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 5,
    });
  }
  return globalSocket;
}

export function useSocket() {
  const socketRef = useRef(null);
  const token = useAuthStore(s => s.token);

  useEffect(() => {
    if (!token) return;
    socketRef.current = getSocket();
    return () => {};
  }, [token]);

  return socketRef.current;
}

export function useServerSocket(serverId, containerId, handlers = {}) {
  const token = useAuthStore(s => s.token);

  useEffect(() => {
    if (!token || !serverId) return;
    const socket = getSocket();

    function subscribe() {
      socket.emit('logs:subscribe', { serverId });
    }

    // Si le socket se reconnecte (perte réseau, restart backend…), se ré-abonner
    socket.on('connect', subscribe);

    // Abonnement initial — uniquement si déjà connecté, sinon le 'connect' s'en charge
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
