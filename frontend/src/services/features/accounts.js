import api from '../api';

// ─── 2FA TOTP ─────────────────────────────────────────────────────────────────

export const verifyTwoFactor = (challenge, { code, recoveryCode }) =>
  api.post('/auth/2fa/verify', { challenge, ...(recoveryCode ? { recoveryCode } : { code }) }).then(r => r.data);

export const getTwoFactorStatus = () =>
  api.get('/auth/2fa/status').then(r => r.data);

export const setupTwoFactor = () =>
  api.post('/auth/2fa/setup').then(r => r.data);

export const enableTwoFactor = (code) =>
  api.post('/auth/2fa/enable', { code }).then(r => r.data);

export const disableTwoFactor = (password, code) =>
  api.post('/auth/2fa/disable', { password, code }).then(r => r.data);

// ─── Comptes utilisateurs ─────────────────────────────────────────────────────

export const getUsers = () =>
  api.get('/users').then(r => r.data);

export const createUser = (payload) =>
  api.post('/users', payload).then(r => r.data);

export const updateUser = (uid, payload) =>
  api.patch(`/users/${uid}`, payload).then(r => r.data);

export const deleteUser = (uid) =>
  api.delete(`/users/${uid}`).then(r => r.data);

export const setUserServerPermissions = (uid, serverId, perms) =>
  api.put(`/users/${uid}/servers/${serverId}`, { perms }).then(r => r.data);

// ─── Journal d'activité ───────────────────────────────────────────────────────

export const getActivity = (params = {}) => {
  const clean = Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
  );
  return api.get('/activity', { params: clean }).then(r => r.data);
};
