import api from '../api';

export const getSchedules = (serverId) =>
  api.get(`/servers/${serverId}/schedules`).then(r => r.data);

export const createSchedule = (serverId, data) =>
  api.post(`/servers/${serverId}/schedules`, data).then(r => r.data);

export const updateSchedule = (serverId, scheduleId, data) =>
  api.patch(`/servers/${serverId}/schedules/${scheduleId}`, data).then(r => r.data);

export const deleteSchedule = (serverId, scheduleId) =>
  api.delete(`/servers/${serverId}/schedules/${scheduleId}`).then(r => r.data);

export const runSchedule = (serverId, scheduleId) =>
  api.post(`/servers/${serverId}/schedules/${scheduleId}/run`, null, { timeout: 60000 }).then(r => r.data);

export const getScheduleRuns = (serverId, scheduleId) =>
  api.get(`/servers/${serverId}/schedules/${scheduleId}/runs`).then(r => r.data);

export const getSchedulePresets = () =>
  api.get('/schedule-presets').then(r => r.data);
