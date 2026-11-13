import api from '../api';

const LONG = { timeout: 180000 };

export const getProfiles = (serverId) =>
  api.get(`/servers/${serverId}/profiles`).then(r => r.data);

export const saveCurrentProfile = (serverId, name) =>
  api.post(`/servers/${serverId}/profiles`, { name }).then(r => r.data);

export const activateProfile = (serverId, profileId) =>
  api.post(`/servers/${serverId}/profiles/${profileId}/activate`, null, LONG).then(r => r.data);

export const renameProfile = (serverId, profileId, name) =>
  api.patch(`/servers/${serverId}/profiles/${profileId}`, { name }).then(r => r.data);

export const deleteProfile = (serverId, profileId) =>
  api.delete(`/servers/${serverId}/profiles/${profileId}`).then(r => r.data);

export const createProfileFromModpack = (serverId, payload) =>
  api.post(`/servers/${serverId}/profiles/new`, payload, LONG).then(r => r.data);
