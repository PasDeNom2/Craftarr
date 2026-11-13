import api from '../api';

export const getRouterSettings = () => api.get('/router/settings').then(r => r.data);
export const updateRouterSettings = (data) => api.put('/router/settings', data).then(r => r.data);
export const getRouterStatus = () => api.get('/router/status').then(r => r.data);
export const patchServerSleep = (serverId, data) => api.patch(`/servers/${serverId}`, data).then(r => r.data);
export const recreateServerContainer = (serverId) => api.post(`/servers/${serverId}/recreate`, null, { timeout: 180000 }).then(r => r.data);
