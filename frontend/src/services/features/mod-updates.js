import api from '../api';

const LONG = { timeout: 180000 };

export const getModUpdates = (serverId, { refresh = false } = {}) =>
  api.get(`/servers/${serverId}/mods/updates`, {
    params: refresh ? { refresh: '1' } : undefined,
  }).then(r => r.data);

export const updateServerMods = (serverId, files) =>
  api.post(`/servers/${serverId}/mods/updates`, { files }, LONG).then(r => r.data);
