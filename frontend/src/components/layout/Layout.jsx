import React, { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import LanguageSwitcher from '../ui/LanguageSwitcher';
import { useServerStore } from '../../store';
import { getServers } from '../../services/api';
import { getSocket } from '../../hooks/useSocket';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';

export default function Layout() {
  const { setServers, updateServer, addServer } = useServerStore();
  const qc = useQueryClient();

  useEffect(() => {
    getServers().then(setServers).catch(console.error);

    const socket = getSocket();

    // Re-fetch la liste des serveurs à chaque reconnexion (rebuild backend, perte réseau…)
    socket.on('connect', () => {
      getServers().then(setServers).catch(console.error);
    });

    socket.on('server:update-available', ({ serverId, serverName, latestVersion }) => {
      toast(`Mise à jour disponible pour ${serverName} → ${latestVersion}`, { duration: 8000 });
    });

    socket.on('server:update-done', ({ serverId, version }) => {
      updateServer(serverId, { status: 'running', modpack_version: version });
    });

    const applyStatus = (serverId, status) => {
      updateServer(serverId, { status });
      qc.setQueryData(['server', serverId], old => old ? { ...old, status } : old);
    };

    socket.on('install:done', ({ serverId }) => applyStatus(serverId, 'running'));
    socket.on('install:error', ({ serverId }) => applyStatus(serverId, 'error'));
    socket.on('server:update-done', ({ serverId, version }) => {
      updateServer(serverId, { status: 'running', modpack_version: version });
      qc.setQueryData(['server', serverId], old => old ? { ...old, status: 'running' } : old);
    });
    socket.on('server:status', ({ serverId, status }) => applyStatus(serverId, status));

    return () => {
      socket.off('connect');
      socket.off('server:update-available');
      socket.off('server:update-done');
      socket.off('install:done');
      socket.off('install:error');
      socket.off('server:status');
    };

  }, []);

  return (
    <div className="flex h-screen overflow-hidden bg-surface">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar with language switcher */}
        <div
          className="flex items-center justify-end px-4 py-2 shrink-0"
          style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
        >
          <LanguageSwitcher />
        </div>
        <main className="flex-1 overflow-y-auto bg-surface">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
