import React, { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import { useServerStore } from '../../store';
import { getServers } from '../../services/api';
import { getSocket } from '../../hooks/useSocket';
import toast from 'react-hot-toast';

export default function Layout() {
  const { setServers, updateServer, addServer } = useServerStore();

  useEffect(() => {
    getServers().then(setServers).catch(console.error);

    const socket = getSocket();

    socket.on('server:update-available', ({ serverId, serverName, latestVersion }) => {
      toast(`Mise à jour disponible pour ${serverName} → ${latestVersion}`, { duration: 8000 });
    });

    socket.on('server:update-done', ({ serverId, version }) => {
      updateServer(serverId, { status: 'running', modpack_version: version });
    });

    socket.on('install:done', ({ serverId }) => {
      updateServer(serverId, { status: 'running' });
    });

    socket.on('install:error', ({ serverId }) => {
      updateServer(serverId, { status: 'error' });
    });

    return () => {
      socket.off('server:update-available');
      socket.off('server:update-done');
      socket.off('install:done');
      socket.off('install:error');
    };
  }, []);

  return (
    <div className="flex h-screen overflow-hidden bg-surface">
      <Sidebar />
      <main className="flex-1 overflow-y-auto bg-surface">
        <Outlet />
      </main>
    </div>
  );
}
