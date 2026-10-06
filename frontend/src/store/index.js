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

/** Thème : 'dark' | 'light' | 'system' (suit le réglage de l'OS). */
const THEMES = new Set(['dark', 'light', 'system']);
const systemTheme = () => (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
function applyTheme(theme, cb) {
  const el = document.documentElement;
  el.setAttribute('data-theme', theme === 'system' ? systemTheme() : theme);
  if (cb) el.setAttribute('data-cb', '1'); else el.removeAttribute('data-cb');
}

export const useThemeStore = create((set, get) => {
  const stored = localStorage.getItem('craftarr_theme');
  // Anciens thèmes Liquid Glass (blue, red, daltonien…) → sombre
  const saved = THEMES.has(stored) ? stored : 'dark';
  const colorblind = localStorage.getItem('craftarr_cb') === '1' || stored === 'daltonien';
  applyTheme(saved, colorblind);
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => {
    if (get().theme === 'system') applyTheme('system', get().colorblind);
  });
  return {
    theme: saved,
    colorblind,
    setTheme: (theme) => {
      if (!THEMES.has(theme)) return;
      localStorage.setItem('craftarr_theme', theme);
      applyTheme(theme, get().colorblind);
      set({ theme });
    },
    setColorblind: (on) => {
      localStorage.setItem('craftarr_cb', on ? '1' : '0');
      applyTheme(get().theme, on);
      set({ colorblind: on });
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
