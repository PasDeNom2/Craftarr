import React, { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import { useServerStore } from '../../store';
import { getServers } from '../../services/api';
import { getSocket } from '../../hooks/useSocket';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import ErrorBoundary from '../ui/ErrorBoundary';
import ConnectionBanner from '../ui/ConnectionBanner';

export default function Layout() {
  const { setServers, updateServer, addServer } = useServerStore();
  const qc = useQueryClient();
  const location = useLocation();

  useEffect(() => {
    // Merge les serveurs reçus avec le store existant pour ne jamais effacer les
    // serveurs déjà présents en cas de réponse partielle ou d'erreur réseau transitoire.
    function mergeServers(fresh) {
      if (!Array.isArray(fresh) || fresh.length === 0) return;
      setServers(fresh);
    }

    function refreshServers() {
      getServers().then(mergeServers).catch(console.error);
    }

    refreshServers();

    const socket = getSocket();

    // Re-fetch la liste des serveurs à chaque reconnexion (rebuild backend, perte réseau…)
    const onConnect = () => refreshServers();
    socket.on('connect', onConnect);

    socket.on('server:update-available', ({ serverName, latestVersion }) => {
      toast(`Mise à jour disponible pour ${serverName} → ${latestVersion}`, { duration: 8000 });
    });

    const applyStatus = (serverId, status, extra = {}) => {
      updateServer(serverId, { status, ...extra });
      qc.setQueryData(['server', serverId], old => old ? { ...old, status, ...extra } : old);
    };

    const onInstallDone    = ({ serverId }) => applyStatus(serverId, 'running');
    const onInstallError   = ({ serverId }) => applyStatus(serverId, 'error');
    const onUpdateDone     = ({ serverId, version }) => applyStatus(serverId, 'running', { modpack_version: version });
    const onServerStatus   = ({ serverId, status }) => applyStatus(serverId, status);
    const onServerCreated  = (server) => {
      // Ajout immédiat si pas déjà dans le store (ex: créé depuis un autre client)
      const { servers } = useServerStore.getState();
      if (!servers.find(s => s.id === server.id)) addServer(server);
    };

    socket.on('install:done',       onInstallDone);
    socket.on('install:error',      onInstallError);
    socket.on('server:update-done', onUpdateDone);
    socket.on('server:status',      onServerStatus);
    socket.on('server:created',     onServerCreated);

    return () => {
      socket.off('connect',           onConnect);
      socket.off('install:done',      onInstallDone);
      socket.off('install:error',     onInstallError);
      socket.off('server:update-done', onUpdateDone);
      socket.off('server:status',     onServerStatus);
      socket.off('server:created',    onServerCreated);
      socket.off('server:update-available');
    };
  }, []);

  return (
    <div className="flex h-screen overflow-hidden bg-bg">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <ConnectionBanner />
        <main className="flex-1 overflow-y-auto atmosphere">
          {/* Une page qui plante n'emporte pas la navigation ; changer de page efface l'erreur */}
          <ErrorBoundary scope="panel" resetKey={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
