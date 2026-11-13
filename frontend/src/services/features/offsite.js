import api from '../api';

const LONG = { timeout: 180000 };

export const getOffsiteSettings = () =>
  api.get('/offsite/settings').then(r => r.data);

export const updateOffsiteSettings = (data) =>
  api.put('/offsite/settings', data).then(r => r.data);

export const testOffsiteRepository = () =>
  api.post('/offsite/test').then(r => r.data);

export const initOffsiteRepository = () =>
  api.post('/offsite/init').then(r => r.data);

export const getServerOffsite = (serverId) =>
  api.get(`/servers/${serverId}/offsite`).then(r => r.data);

export const runServerOffsiteBackup = (serverId) =>
  api.post(`/servers/${serverId}/offsite/run`).then(r => r.data);

export const restoreServerOffsiteSnapshot = (serverId, snapshotId) =>
  api.post(`/servers/${serverId}/offsite/restore`, { snapshotId }, LONG).then(r => r.data);
