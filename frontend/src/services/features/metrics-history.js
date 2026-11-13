import api from '../api';

export const getMetricsHistory = (serverId, range) =>
  api.get(`/servers/${serverId}/metrics/history`, { params: { range } }).then(r => r.data);
