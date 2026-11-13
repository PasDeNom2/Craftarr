import api from '../api';

export const getApiKeys = ({ all = false } = {}) =>
  api.get('/api-keys', all ? { params: { all: '1' } } : undefined).then(r => r.data);

export const createApiKey = (payload) =>
  api.post('/api-keys', payload).then(r => r.data);

export const revokeApiKey = (id) =>
  api.delete(`/api-keys/${encodeURIComponent(id)}`).then(r => r.data);

export const getOpenApiSpec = () =>
  api.get('/openapi.json').then(r => r.data);
