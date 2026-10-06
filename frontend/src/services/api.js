import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
});

// Opérations qui arrêtent un serveur : Docker laisse jusqu'à 120 s à Minecraft pour sauvegarder
const LONG = { timeout: 180000 };

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
export const setupAdmin = (username, password, setupToken) =>
  api.post('/auth/setup', { username, password, setupToken }).then(r => r.data);
export const login = (username, password) =>
  api.post('/auth/login', { username, password }).then(r => r.data);

export const getMe = () => api.get('/auth/me').then(r => r.data);

// Catalog
export const getCatalog = (params) => api.get('/catalog', { params }).then(r => r.data);
export const getModpackDetail = (source, id) => api.get(`/catalog/${source}/${id}`).then(r => r.data);
export const getModpackVersions = (source, id) => api.get(`/catalog/${source}/${id}/versions`).then(r => r.data);
export const getModpackMods     = (source, id) => api.get(`/catalog/${source}/${id}/mods`).then(r => r.data);

// Servers
export const getServers = () => api.get('/servers').then(r => r.data);
export const getServer = (id) => api.get(`/servers/${id}`).then(r => r.data);
export const createServer = (data) => api.post('/servers', data).then(r => r.data);
export const deleteServer = (id) => api.delete(`/servers/${id}`, LONG).then(r => r.data);
export const startServer = (id) => api.post(`/servers/${id}/start`).then(r => r.data);
export const stopServer = (id) => api.post(`/servers/${id}/stop`, null, LONG).then(r => r.data);
export const restartServer = (id) => api.post(`/servers/${id}/restart`, null, LONG).then(r => r.data);
export const backupServer = (id) => api.post(`/servers/${id}/backup`, null, LONG).then(r => r.data);
export const sendRcon = (id, command) => api.post(`/servers/${id}/rcon`, { command }).then(r => r.data);
export const updateServer = (id, versionId) =>
  api.post(`/servers/${id}/update`, versionId ? { version_id: versionId } : {}).then(r => r.data);
export const importWorld = (id, file) => {
  const fd = new FormData();
  fd.append('world', file);
  return api.post(`/servers/${id}/world-import`, fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 30 * 60 * 1000, // upload jusqu'à 2 Go + arrêt du serveur
  }).then(r => r.data);
};

// Téléchargement natif du navigateur via un lien signé à usage unique : le zip est streamé
// directement sur le disque (pas de blob en mémoire, pas de timeout axios sur les gros mondes).
export const downloadWorld = async (id, serverName) => {
  const { url } = await api.post(`/servers/${id}/world-download-token`).then(r => r.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${serverName}_world.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
};

export const patchServer = (id, data) => api.patch(`/servers/${id}`, data).then(r => r.data);
export const recreateContainer = (id) => api.post(`/servers/${id}/recreate`, null, LONG).then(r => r.data);
export const installMods = (id) => api.post(`/servers/${id}/install-mods`).then(r => r.data);
export const reinstallServer = (id) => api.post(`/servers/${id}/reinstall`).then(r => r.data);
export const confirmClientPack = (id) => api.post(`/servers/${id}/install/confirm-client-pack`).then(r => r.data);
export const cancelInstall = (id) => api.post(`/servers/${id}/install/cancel`).then(r => r.data);
export const uploadServerIcon = (id, file) => {
  const fd = new FormData();
  fd.append('icon', file);
  return api.post(`/servers/${id}/icon`, fd, { headers: { 'Content-Type': 'multipart/form-data' } }).then(r => r.data);
};
export const getServerIconUrl = (id) => `/api/servers/${id}/icon`;
export const getFiles = (id, path = '') => api.get(`/servers/${id}/files`, { params: { path } }).then(r => r.data);
export const getFileContent = (id, path) => api.get(`/servers/${id}/files/content`, { params: { path } }).then(r => r.data);
export const putFileContent = (id, path, content, opts = {}) => api.put(`/servers/${id}/files/content`, { path, content, ...opts }).then(r => r.data);
export const getNbt = (id, path) => api.get(`/servers/${id}/files/nbt`, { params: { path } }).then(r => r.data);
export const putNbt = (id, path, content, opts = {}) => api.put(`/servers/${id}/files/nbt`, { path, content, ...opts }).then(r => r.data);
export const restartPregen = (id) => api.post(`/servers/${id}/pregen/restart`).then(r => r.data);
export const makeDir = (id, path) => api.post(`/servers/${id}/files/mkdir`, { path }).then(r => r.data);
export const renameFile = (id, from, to) => api.post(`/servers/${id}/files/rename`, { from, to }).then(r => r.data);
export const deleteFiles = (id, paths) => api.post(`/servers/${id}/files/delete`, { paths }).then(r => r.data);
export const getFileBlob = (id, path) => api.get(`/servers/${id}/files/raw`, { params: { path }, responseType: 'blob' }).then(r => r.data);
export const uploadFiles = (id, dir, files, { overwrite = false, onProgress } = {}) => {
  const fd = new FormData();
  for (const f of files) fd.append('files', f, f.name);
  return api.post(`/servers/${id}/files/upload`, fd, {
    params: { path: dir, overwrite: overwrite ? '1' : undefined },
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 60 * 60 * 1000,
    onUploadProgress: e => onProgress?.(e.total ? e.loaded / e.total : 0),
  }).then(r => r.data);
};
// Téléchargement natif (fichier seul, ou zip pour un dossier / une sélection) via lien signé
export const downloadFiles = async (id, paths) => {
  const { url } = await api.post(`/servers/${id}/files/download-token`, { paths }).then(r => r.data);
  const a = document.createElement('a');
  a.href = url;
  document.body.appendChild(a);
  a.click();
  a.remove();
};

// Backups
export const getBackups = (serverId) => api.get(`/servers/${serverId}/backups`).then(r => r.data);
export const deleteBackup = (serverId, backupId) => api.delete(`/servers/${serverId}/backups/${backupId}`).then(r => r.data);
export const restoreBackup = (serverId, backupId) => api.post(`/servers/${serverId}/backups/${backupId}/restore`, null, LONG).then(r => r.data);

// Players
export const getPlayers = (serverId) => api.get(`/servers/${serverId}/players`).then(r => r.data);
export const getPlayersOverview = (serverId, days = 30) => api.get(`/servers/${serverId}/players/overview`, { params: { days } }).then(r => r.data);
export const getPlayerProfile = (serverId, username) => api.get(`/servers/${serverId}/players/${encodeURIComponent(username)}/profile`).then(r => r.data);
export const getPlayerEvents = (serverId, username, params) => api.get(`/servers/${serverId}/players/${encodeURIComponent(username)}/events`, { params }).then(r => r.data);
export const kickPlayer = (serverId, username, reason) => api.post(`/servers/${serverId}/players/${encodeURIComponent(username)}/kick`, { reason }).then(r => r.data);
export const warnPlayer = (serverId, username, reason) => api.post(`/servers/${serverId}/players/${encodeURIComponent(username)}/warn`, { reason }).then(r => r.data);
export const banPlayer = (serverId, username, reason) => api.post(`/servers/${serverId}/players/${encodeURIComponent(username)}/ban`, { reason }).then(r => r.data);
export const unbanPlayer = (serverId, username) => api.delete(`/servers/${serverId}/players/${encodeURIComponent(username)}/ban`).then(r => r.data);
export const opPlayer = (serverId, username) => api.post(`/servers/${serverId}/players/${encodeURIComponent(username)}/op`).then(r => r.data);
export const deopPlayer = (serverId, username) => api.delete(`/servers/${serverId}/players/${encodeURIComponent(username)}/op`).then(r => r.data);

// Whitelist
export const getWhitelist = (serverId) => api.get(`/servers/${serverId}/whitelist`).then(r => r.data);
export const addToWhitelist = (serverId, username) => api.post(`/servers/${serverId}/whitelist`, { username }).then(r => r.data);
export const removeFromWhitelist = (serverId, username) => api.delete(`/servers/${serverId}/whitelist/${encodeURIComponent(username)}`).then(r => r.data);

// Vanilla
export const getVanillaVersions = (type = 'release') => api.get('/vanilla/versions', { params: { type } }).then(r => r.data);

// Sources
export const getSources = () => api.get('/sources').then(r => r.data);
export const createSource = (data) => api.post('/sources', data).then(r => r.data);
export const updateSource = (id, data) => api.patch(`/sources/${id}`, data).then(r => r.data);
export const deleteSource = (id) => api.delete(`/sources/${id}`).then(r => r.data);
export const testSource = (id) => api.post(`/sources/${id}/test`).then(r => r.data);
export const exportSources = () => api.get('/sources/export').then(r => r.data);
export const importSources = (data) => api.post('/sources/import', data).then(r => r.data);

export default api;

// Mods d'un serveur
export const getMods = (serverId) => api.get(`/servers/${serverId}/mods`).then(r => r.data);
export const setModEnabled = (serverId, file, enabled) => api.patch(`/servers/${serverId}/mods`, { file, enabled }).then(r => r.data);
export const trashMods = (serverId, files) => api.post(`/servers/${serverId}/mods/trash`, { files }).then(r => r.data);
export const searchMods = (serverId, q, source) => api.get(`/servers/${serverId}/mods/search`, { params: { q, source } }).then(r => r.data);
export const installMod = (serverId, source, projectId) => api.post(`/servers/${serverId}/mods/install`, { source, projectId }, LONG).then(r => r.data);
export const fixModDependencies = (serverId) => api.post(`/servers/${serverId}/mods/fix-dependencies`, null, LONG).then(r => r.data);
export const uploadMods = (serverId, files, onProgress) => {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  return api.post(`/servers/${serverId}/mods/upload`, fd, {
    timeout: 0,
    onUploadProgress: e => onProgress?.(e.total ? Math.round((e.loaded / e.total) * 100) : 0),
  }).then(r => r.data);
};

// Compte et réglages globaux
export const changePassword = (currentPassword, newPassword) => api.post('/auth/password', { currentPassword, newPassword }).then(r => r.data);
export const getAppSettings = () => api.get('/settings').then(r => r.data);
export const patchAppSettings = (data) => api.patch('/settings', data).then(r => r.data);
export const testNotification = () => api.post('/settings/notify-test').then(r => r.data);
