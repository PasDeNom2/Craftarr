import api from '../api';

export const getDiagnostics = (serverId) =>
  api.get(`/servers/${serverId}/diagnostics`).then(r => r.data);

export const getDiagnosticFile = (serverId, name) =>
  api.get(`/servers/${serverId}/diagnostics/file`, { params: { name } }).then(r => r.data);

export const installSpark = (serverId) =>
  api.post(`/servers/${serverId}/diagnostics/spark/install`, null, { timeout: 120000 }).then(r => r.data);

export const runSparkProfile = (serverId, kind) =>
  api.post(`/servers/${serverId}/diagnostics/spark/profile`, { kind }, { timeout: 150000 }).then(r => r.data);

export const shareDiagnosticFile = (serverId, name) =>
  api.post(`/servers/${serverId}/diagnostics/share`, { name }, { timeout: 30000 }).then(r => r.data);
