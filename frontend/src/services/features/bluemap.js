import api from '../api';

export const getBluemapStatus = (serverId) =>
  api.get(`/servers/${serverId}/bluemap`).then(r => r.data);

export const enableBluemap = (serverId) =>
  api.post(`/servers/${serverId}/bluemap/enable`).then(r => r.data);

export const disableBluemap = (serverId) =>
  api.post(`/servers/${serverId}/bluemap/disable`).then(r => r.data);
