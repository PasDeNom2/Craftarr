import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
// Langue de repli pour toute clé absente d'une traduction (jamais de clé brute à l'écran)
import FALLBACK_MESSAGES from './locales/en.json';

// ─── Supported languages ──────────────────────────────────────────────────────
export const LANGUAGES = [
  { code: 'fr', name: 'Français', native: 'Français', flag: '🇫🇷' },
  { code: 'en', name: 'English', native: 'English', flag: '🇬🇧' },
  { code: 'es', name: 'Spanish', native: 'Español', flag: '🇪🇸' },
  { code: 'de', name: 'German', native: 'Deutsch', flag: '🇩🇪' },
  { code: 'pt', name: 'Portuguese', native: 'Português', flag: '🇧🇷' },
  { code: 'it', name: 'Italian', native: 'Italiano', flag: '🇮🇹' },
  { code: 'ru', name: 'Russian', native: 'Русский', flag: '🇷🇺' },
  { code: 'zh', name: 'Chinese', native: '中文', flag: '🇨🇳' },
  { code: 'ja', name: 'Japanese', native: '日本語', flag: '🇯🇵' },
  { code: 'ko', name: 'Korean', native: '한국어', flag: '🇰🇷' },
  { code: 'ar', name: 'Arabic', native: 'العربية', flag: '🇸🇦' },
  { code: 'pl', name: 'Polish', native: 'Polski', flag: '🇵🇱' },
  { code: 'nl', name: 'Dutch', native: 'Nederlands', flag: '🇳🇱' },
  { code: 'tr', name: 'Turkish', native: 'Türkçe', flag: '🇹🇷' },
  { code: 'uk', name: 'Ukrainian', native: 'Українська', flag: '🇺🇦' },
  { code: 'sv', name: 'Swedish', native: 'Svenska', flag: '🇸🇪' },
  { code: 'cs', name: 'Czech', native: 'Čeština', flag: '🇨🇿' },
];

// ─── Traductions des fonctionnalités ─────────────────────────────────────────
// locales/features/<fonctionnalité>.<langue>.json, fusionnées dans la langue correspondante
// (en et fr suffisent : les autres langues retombent sur l'anglais).
const FEATURE_FILES = import.meta.glob('./locales/features/*.json', { eager: true });
function deepMerge(target, source) {
  const out = { ...target };
  for (const [k, v] of Object.entries(source || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(out[k] || {}, v) : v;
  }
  return out;
}
function featureMessages(code) {
  let merged = {};
  for (const [file, mod] of Object.entries(FEATURE_FILES)) {
    if (file.endsWith(`.${code}.json`)) merged = deepMerge(merged, mod.default || mod);
  }
  return merged;
}
const FALLBACK = deepMerge(FALLBACK_MESSAGES, featureMessages('en'));

// ─── Lazy locale loader ───────────────────────────────────────────────────────
const localeCache = {};
async function loadLocale(code) {
  if (localeCache[code]) return localeCache[code];
  try {
    const mod = await import(`./locales/${code}.json`);
    localeCache[code] = deepMerge(mod.default, featureMessages(code));
    return localeCache[code];
  } catch {
    // fallback to French
    if (code !== 'fr') return loadLocale('fr');
    return {};
  }
}

// ─── Detect initial language ──────────────────────────────────────────────────
function detectLang() {
  const stored = localStorage.getItem('mcm_lang');
  if (stored && LANGUAGES.find(l => l.code === stored)) return stored;
  const browser = (navigator.language || 'fr').split('-')[0].toLowerCase();
  if (LANGUAGES.find(l => l.code === browser)) return browser;
  return 'fr';
}

// ─── Deep get helper ──────────────────────────────────────────────────────────
function deepGet(obj, path, fallback) {
  const result = path.split('.').reduce((acc, key) => acc?.[key], obj);
  return result !== undefined ? result : fallback;
}

// ─── Context ──────────────────────────────────────────────────────────────────
const I18nContext = createContext(null);

export function I18nProvider({ children }) {
  const [lang, setLang] = useState(detectLang);
  const [messages, setMessages] = useState(() => {
    // Synchronously load from cache if available (populated by eager import below)
    return localeCache[detectLang()] || {};
  });
  const [loading, setLoading] = useState(!localeCache[detectLang()]);

  // Eager-load the initial locale
  useEffect(() => {
    const initial = detectLang();
    loadLocale(initial).then(m => {
      setMessages(m);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  }, [lang]);

  const changeLang = useCallback(async (code) => {
    const m = await loadLocale(code);
    localStorage.setItem('mcm_lang', code);
    setMessages(m);
    setLang(code);
  }, []);

  const t = useCallback((key, vars) => {
    let str = deepGet(messages, key, undefined) ?? deepGet(FALLBACK, key, key);
    if (vars && typeof str === 'string') {
      Object.entries(vars).forEach(([k, v]) => {
        str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
      });
    }
    return str;
  }, [messages]);

  return (
    <I18nContext.Provider value={{ t, lang, changeLang, loading }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside I18nProvider');
  return ctx;
}
