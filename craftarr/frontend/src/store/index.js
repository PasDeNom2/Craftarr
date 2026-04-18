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

export const useMetricsStore = create((set) => ({
  metrics: {},  // { [serverId]: metricsObject }
  updateMetrics: (serverId, data) => set(state => ({
    metrics: { ...state.metrics, [serverId]: data },
  })),
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
