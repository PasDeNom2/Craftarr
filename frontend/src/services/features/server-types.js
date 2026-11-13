import api from '../api';

export const getServerTypeVersions = (type) =>
  api.get(`/vanilla/server-types/${encodeURIComponent(type)}/versions`).then(r => r.data);
