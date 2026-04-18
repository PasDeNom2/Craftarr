import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
});

// Injection automatique du token JWT
api.interceptors.request.use(config => {
  const token = localStorage.getItem('mcm_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Redirection vers login si 401
api.interceptors.response.use(
  res => res,
  err => {
    if (err.response?.status === 401) {
      localStorage.removeItem('mcm_token');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

// Auth
export const checkSetupNeeded = () =>
  api.get('/auth/setup-needed').then(r => r.data);
export const setupAdmin = (username, password) =>
  api.post('/auth/setup', { username, password }).then(r => r.data);
export const login = (username, password) =>
  api.post('/auth/login', { username, password }).then(r => r.data);

export const getMe = () => api.get('/auth/me').then(r => r.data);

// Catalog
export const getCatalog = (params) => api.get('/catalog', { params }).then(r => r.data);
export const getModpackDetail = (source, id) => api.get(`/catalog/${source}/${id}`).then(r => r.data);
export const getModpackVersions = (source, id) => api.get(`/catalog/${source}/${id}/versions`).then(r => r.data);

// Servers
export const getServers = () => api.get('/servers').then(r => r.data);
export const getServer = (id) => api.get(`/servers/${id}`).then(r => r.data);
export const createServer = (data) => api.post('/servers', data).then(r => r.data);
export const deleteServer = (id) => api.delete(`/servers/${id}`).then(r => r.data);
export const startServer = (id) => api.post(`/servers/${id}/start`).then(r => r.data);
export const stopServer = (id) => api.post(`/servers/${id}/stop`).then(r => r.data);
export const restartServer = (id) => api.post(`/servers/${id}/restart`).then(r => r.data);
export const backupServer = (id) => api.post(`/servers/${id}/backup`).then(r => r.data);
export const sendRcon = (id, command) => api.post(`/servers/${id}/rcon`, { command }).then(r => r.data);
export const getServerMetrics = (id) => api.get(`/servers/${id}/metrics`).then(r => r.data);
export const updateServer = (id, versionId) =>
  api.post(`/servers/${id}/update`, versionId ? { version_id: versionId } : {}).then(r => r.data);
export const importWorld = (id, file) => {
  const fd = new FormData();
  fd.append('world', file);
  return api.post(`/servers/${id}/world-import`, fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 120000,
  }).then(r => r.data);
};

export const patchServer = (id, data) => api.patch(`/servers/${id}`, data).then(r => r.data);
export const recreateContainer = (id) => api.post(`/servers/${id}/recreate`).then(r => r.data);
export const installMods = (id) => api.post(`/servers/${id}/install-mods`).then(r => r.data);
export const uploadServerIcon = (id, file) => {
  const fd = new FormData();
  fd.append('icon', file);
  return api.post(`/servers/${id}/icon`, fd, { headers: { 'Content-Type': 'multipart/form-data' } }).then(r => r.data);
};
export const getServerIconUrl = (id) => `/api/servers/${id}/icon`;
export const getFiles = (id, path = '') => api.get(`/servers/${id}/files`, { params: { path } }).then(r => r.data);
export const getFileContent = (id, path) => api.get(`/servers/${id}/files/content`, { params: { path } }).then(r => r.data);
export const putFileContent = (id, path, content) => api.put(`/servers/${id}/files/content`, { path, content }).then(r => r.data);

// Players
export const getPlayers = (serverId) => api.get(`/servers/${serverId}/players`).then(r => r.data);
export const getPlayerEvents = (serverId, username) => api.get(`/servers/${serverId}/players/${username}/events`).then(r => r.data);

// Backups
export const getBackups = (serverId) => api.get(`/servers/${serverId}/backups`).then(r => r.data);
export const deleteBackup = (serverId, backupId) => api.delete(`/servers/${serverId}/backups/${backupId}`).then(r => r.data);
export const restoreBackup = (serverId, backupId) => api.post(`/servers/${serverId}/backups/${backupId}/restore`).then(r => r.data);

// Sources
export const getSources = () => api.get('/sources').then(r => r.data);
export const createSource = (data) => api.post('/sources', data).then(r => r.data);
export const updateSource = (id, data) => api.patch(`/sources/${id}`, data).then(r => r.data);
export const deleteSource = (id) => api.delete(`/sources/${id}`).then(r => r.data);
export const testSource = (id) => api.post(`/sources/${id}/test`).then(r => r.data);
export const exportSources = () => api.get('/sources/export').then(r => r.data);
export const importSources = (data) => api.post('/sources/import', data).then(r => r.data);

export default api;
