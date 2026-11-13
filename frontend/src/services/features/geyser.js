import api from '../api';

export const getGeyserStatus = (serverId) =>
  api.get(`/servers/${serverId}/geyser`).then(r => r.data);

export const enableGeyser = (serverId, { floodgate = true } = {}) =>
  api.post(`/servers/${serverId}/geyser/enable`, { floodgate }, { timeout: 120000 }).then(r => r.data);

export const disableGeyser = (serverId) =>
  api.post(`/servers/${serverId}/geyser/disable`).then(r => r.data);
