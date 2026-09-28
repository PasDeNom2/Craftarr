import { create } from 'zustand';

export const useAuthStore = create((set) => ({
  token: localStorage.getItem('mcm_token'),
  user: null,
  setToken: (token) => {
    localStorage.setItem('mcm_token', token);
    set({ token });
  },
  setUser: (user) => set({ user }),
  logout: () => {
    localStorage.removeItem('mcm_token');
    set({ token: null, user: null });
  },
}));

export const useServerStore = create((set, get) => ({
  servers: [],
  setServers: (servers) => set({ servers }),
  updateServer: (id, patch) => set(state => ({
    servers: state.servers.map(s => s.id === id ? { ...s, ...patch } : s),
  })),
  removeServer: (id) => set(state => ({
    servers: state.servers.filter(s => s.id !== id),
  })),
  addServer: (server) => set(state => ({
    servers: [server, ...state.servers],
  })),
}));

// Historique gardé en mémoire (~10 min à un point toutes les 2 s) : survit aux changements d'onglet
const METRICS_HISTORY = 300;

export const useMetricsStore = create((set) => ({
  metrics: {},  // { [serverId]: metricsObject }
  history: {},  // { [serverId]: [{ t, memUsed, cpu, tps, players }] }
  updateMetrics: (serverId, data) => set(state => {
    const prev = state.history[serverId] || [];
    const point = {
      t: Date.now(),
      memUsed: data.memUsed ?? null,
      cpu: data.cpu != null ? +data.cpu.toFixed(1) : null,
      tps: data.tps?.tps1 ?? prev[prev.length - 1]?.tps ?? null,
      players: data.players?.online ?? prev[prev.length - 1]?.players ?? null,
    };
    const next = prev.length >= METRICS_HISTORY ? [...prev.slice(1 - METRICS_HISTORY), point] : [...prev, point];
    return {
      metrics: { ...state.metrics, [serverId]: data },
      history: { ...state.history, [serverId]: next },
    };
  }),
}));

export const useThemeStore = create((set) => {
  const saved = localStorage.getItem('craftarr_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  return {
    theme: saved,
    setTheme: (theme) => {
      localStorage.setItem('craftarr_theme', theme);
      document.documentElement.setAttribute('data-theme', theme);
      set({ theme });
    },
  };
});

export const useIconStore = create((set) => ({
  versions: {},  // { [serverId]: timestamp }
  bumpIcon: (serverId) => set(state => ({
    versions: { ...state.versions, [serverId]: Date.now() },
  })),
}));

export const useLogsStore = create((set) => ({
  logs: {},  // { [serverId]: string[] }
  appendLog: (serverId, line) => set(state => {
    const prev = state.logs[serverId] || [];
    const next = prev.length > 2000 ? prev.slice(-1800) : prev;
    return { logs: { ...state.logs, [serverId]: [...next, line] } };
  }),
  clearLogs: (serverId) => set(state => ({
    logs: { ...state.logs, [serverId]: [] },
  })),
}));
