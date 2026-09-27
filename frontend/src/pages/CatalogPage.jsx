import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getCatalog } from '../services/api';
import { useServerStore } from '../store';
import { useI18n } from '../i18n';
import ModpackCard from '../components/catalog/ModpackCard';
import ModpackDetail from '../components/catalog/ModpackDetail';
import DeployModal from '../components/catalog/DeployModal';
import VanillaModal from '../components/catalog/VanillaModal';
import { Search, X, AlertCircle, Box, SlidersHorizontal, ChevronDown } from 'lucide-react';

const MC_VERSIONS = ['26.2', '26.1.2', '26.1', '1.21.4', '1.21.1', '1.21', '1.20.4', '1.20.1', '1.19.4', '1.19.2', '1.18.2', '1.16.5', '1.12.2', '1.7.10'];
const SOURCES = ['modrinth', 'curseforge'];
const CATEGORY_KEYS = [
  'adventure', 'technology', 'magic', 'exploration', 'combat',
  'quests', 'multiplayer', 'challenging', 'kitchen-sink', 'lightweight', 'sci-fi',
];

function useFilterDefs(t) {
  return [
    {
      key: 'mcVersion',
      label: t('catalog.filterVersion'),
      options: MC_VERSIONS.map(v => ({ value: v, label: v })),
    },
    {
      key: 'category',
      label: t('catalog.filterCategory'),
      options: CATEGORY_KEYS.map(k => ({ value: k, label: t(`catalog.category.${k}`) })),
    },
    {
      key: 'source',
      label: t('catalog.filterSource'),
      options: SOURCES.map(s => ({ value: s, label: s === 'curseforge' ? 'CurseForge' : 'Modrinth' })),
    },
  ];
}

// Couleurs par type de filtre
const FILTER_COLORS = {
  mcVersion: { bg: 'rgba(var(--accent-rgb),0.1)', border: 'rgba(var(--accent-rgb),0.3)', text: 'var(--accent)', dot: 'var(--accent)' },
  category:  { bg: 'rgba(var(--purple-rgb),0.08)', border: 'rgba(var(--purple-rgb),0.25)', text: 'var(--purple)', dot: 'var(--purple)' },
source:    { bg: 'rgba(var(--warn-rgb),0.08)', border: 'rgba(var(--warn-rgb),0.25)', text: 'var(--warn)',  dot: 'var(--warn)' },
};

// activeFilters = { mcVersion: ['1.21', '1.20.1'], category: ['adventure'], source: ['modrinth'] }
function FilterPanel({ activeFilters, onToggle, onClear, onClose, filterDefs, t }) {
  const ref = useRef(null);
  const totalActive = Object.values(activeFilters).reduce((n, arr) => n + arr.length, 0);

  useEffect(() => {
    function onClick(e) { if (ref.current && !ref.current.contains(e.target)) onClose(); }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-2 rounded-xl z-50 flex flex-col pop-in"
      style={{
        width: '340px',
        background: 'var(--surface)',
        boxShadow: 'var(--shadow-pop)',
        maxHeight: '520px',
        overflowY: 'auto',
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 sticky top-0" style={{ background: 'var(--surface)', borderBottom: '1px solid var(--line)' }}>
        <span className="text-xs font-semibold text-fg uppercase tracking-widest">{t('catalog.filters')}</span>
        {totalActive > 0 && (
          <button onClick={onClear} className="text-[11px] text-danger hover:text-red-400 transition-colors">
            {t('catalog.filtersClear')} ({totalActive})
          </button>
        )}
      </div>

      <div className="p-4 flex flex-col gap-5">
        {filterDefs.map(def => {
          const col = FILTER_COLORS[def.key];
          const selected = activeFilters[def.key] || [];
          return (
            <div key={def.key}>
              <div className="flex items-center gap-2 mb-2">
                <p className="text-[11px] font-semibold text-fg-3 uppercase tracking-widest">{def.label}</p>
                {selected.length > 0 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold"
                    style={{ background: col.bg, color: col.text, border: `1px solid ${col.border}` }}>
                    {selected.length}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {def.options.map(opt => {
                  const active = selected.includes(opt.value);
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => onToggle(def.key, opt.value)}
                      className="text-xs px-2.5 py-1 rounded-lg transition-all duration-150 font-medium flex items-center gap-1.5"
                      style={{
                        background: active ? col.bg : 'rgba(255,255,255,0.04)',
                        border: `1px solid ${active ? col.border : 'rgba(255,255,255,0.07)'}`,
                        color: active ? col.text : 'var(--fg-2)',
                      }}
                    >
                      {active && <span className="w-1 h-1 rounded-full shrink-0" style={{ background: col.dot }} />}
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function CatalogPage() {
  const [query, setQuery] = useState('');
  const [inputValue, setInputValue] = useState('');
  const [activeFilters, setActiveFilters] = useState({});
  const [filterOpen, setFilterOpen] = useState(false);
  const [selectedModpack, setSelectedModpack] = useState(null);
  const [deployModpack, setDeployModpack] = useState(null);
  const [vanillaOpen, setVanillaOpen] = useState(false);
  const { t } = useI18n();
  const filterDefs = useFilterDefs(t);

  const servers = useServerStore(s => s.servers);
  const runningCount = servers.filter(s => s.status === 'running').length;
  const stoppedCount = servers.filter(s => s.status === 'stopped').length;
  const installingCount = servers.filter(s => ['installing', 'updating'].includes(s.status)).length;

  // activeFilters: { key: string[] }
  const totalFilterCount = Object.values(activeFilters).reduce((n, arr) => n + arr.length, 0);

  function toggleFilter(key, value) {
    setActiveFilters(prev => {
      const current = prev[key] || [];
      const exists = current.includes(value);
      const next = exists ? current.filter(v => v !== value) : [...current, value];
      if (next.length === 0) {
        const copy = { ...prev };
        delete copy[key];
        return copy;
      }
      return { ...prev, [key]: next };
    });
  }

  function removeFilterValue(key, value) {
    setActiveFilters(prev => {
      const next = (prev[key] || []).filter(v => v !== value);
      if (next.length === 0) { const copy = { ...prev }; delete copy[key]; return copy; }
      return { ...prev, [key]: next };
    });
  }

  function clearAllFilters() {
    setActiveFilters({});
  }

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['catalog', query, activeFilters],
    queryFn: () => getCatalog({
      query,
      mcVersion:  (activeFilters.mcVersion  || []).join(',') || undefined,
      category:   (activeFilters.category   || []).join(',') || undefined,
      loader:     (activeFilters.loader     || []).join(',') || undefined,
      source:     (activeFilters.source     || []).join(',') || undefined,
      limit: 40,
    }),
    staleTime: 60000,
  });

  const modpacks = data?.data || [];

  const handleSearch = useCallback((e) => {
    e.preventDefault();
    setQuery(inputValue.trim());
  }, [inputValue]);

  const hasActiveSearch = query || totalFilterCount > 0;

  return (
    <div className="px-8 py-8 max-w-screen-2xl mx-auto">
      {/* ── En-tête ── */}
      <header className="flex items-end justify-between gap-6 flex-wrap mb-8 card-in">
        <div>
          <p className="eyebrow mb-2">{t('nav.catalogue')}</p>
          <h1 className="font-display text-[34px] leading-none font-semibold text-fg tracking-tight">{t('catalog.title')}</h1>
          <p className="text-sm text-fg-2 mt-3 max-w-xl">{t('catalog.subtitle')}</p>
        </div>

        <div className="flex gap-3">
          <StatCard label={t('catalog.activeServers')} value={runningCount} color="var(--accent)" live={runningCount > 0} />
          <StatCard label={t('catalog.stoppedServers')} value={stoppedCount} color="var(--fg-3)" />
          <StatCard label={t('catalog.inProgress')} value={installingCount} color="var(--warn)" live={installingCount > 0} />
        </div>
      </header>

      {/* ── Recherche ── */}
      <form onSubmit={handleSearch} className="flex gap-2.5 mb-4 card-in" style={{ animationDelay: '60ms' }}>
        <div className="flex-1 relative">
          <Search size={17} strokeWidth={1.75} className="absolute left-4 top-1/2 -translate-y-1/2 text-fg-3 pointer-events-none" />
          <input
            className="input h-12 pl-11 pr-24 text-[15px] rounded-xl bg-surface"
            placeholder={t('catalog.search')}
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
          />
          <kbd className="absolute right-3 top-1/2 -translate-y-1/2 hidden md:inline-flex items-center gap-1 text-[10px] font-mono text-fg-3 px-1.5 py-0.5 rounded-md border border-line bg-bg-2">
            ⏎
          </kbd>
        </div>

        <div className="relative">
          <button
            type="button"
            onClick={() => setFilterOpen(o => !o)}
            className="btn h-12 px-4 rounded-xl"
            style={{
              background: totalFilterCount > 0 ? 'rgba(var(--accent-rgb),0.1)' : 'var(--surface)',
              border: `1px solid ${totalFilterCount > 0 ? 'rgba(var(--accent-rgb),0.35)' : 'var(--line)'}`,
              color: totalFilterCount > 0 ? 'var(--accent)' : 'var(--fg-2)',
            }}
          >
            <SlidersHorizontal size={15} strokeWidth={1.75} />
            <span className="hidden sm:inline">{t('catalog.filters')}</span>
            {totalFilterCount > 0 && (
              <span className="font-pixel text-[10px] min-w-[18px] h-[18px] px-1 rounded-md flex items-center justify-center" style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}>
                {totalFilterCount}
              </span>
            )}
            <ChevronDown size={13} strokeWidth={2} style={{ transform: filterOpen ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }} />
          </button>
          {filterOpen && (
            <FilterPanel
              activeFilters={activeFilters}
              onToggle={toggleFilter}
              onClear={clearAllFilters}
              onClose={() => setFilterOpen(false)}
              filterDefs={filterDefs}
              t={t}
            />
          )}
        </div>

        <button type="button" onClick={() => setVanillaOpen(true)} className="btn-secondary h-12 px-4 rounded-xl" title={t('catalog.vanillaHint')}>
          <Box size={15} strokeWidth={1.75} />
          <span className="hidden lg:inline">{t('catalog.vanilla')}</span>
        </button>
      </form>

      {/* Filtres actifs + compteur */}
      <div className="flex items-center justify-between gap-3 mb-5 min-h-[28px] flex-wrap">
        <div className="flex flex-wrap gap-2">
          {Object.entries(activeFilters).flatMap(([key, values]) => {
            const col = FILTER_COLORS[key];
            const def = filterDefs.find(d => d.key === key);
            return values.map(value => {
              const label = def?.options.find(o => o.value === value)?.label || value;
              return (
                <span
                  key={`${key}:${value}`}
                  className="flex items-center gap-1.5 text-xs pl-2 pr-1.5 py-1 rounded-lg font-medium fade-in"
                  style={{ background: col.bg, border: `1px solid ${col.border}`, color: col.text }}
                >
                  <span className="status-block" style={{ width: 6, height: 6, color: col.dot }} />
                  {label}
                  <button onClick={() => removeFilterValue(key, value)} className="ml-0.5 p-0.5 rounded hover:bg-black/20" type="button" aria-label="×">
                    <X size={11} strokeWidth={2.5} />
                  </button>
                </span>
              );
            });
          })}
          {hasActiveSearch && (
            <button
              type="button"
              className="text-xs text-fg-3 hover:text-fg px-2 py-1 rounded-lg transition-colors inline-flex items-center gap-1"
              onClick={() => { setQuery(''); setInputValue(''); setActiveFilters({}); }}
            >
              <X size={12} /> {t('catalog.clear')}
            </button>
          )}
        </div>
        {!isLoading && !isError && (
          <span className="text-xs text-fg-3">
            <span className="font-pixel text-fg-2">{modpacks.length}</span> {t('catalog.results')}
          </span>
        )}
      </div>

      {/* ── Résultats ── */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
          {Array.from({ length: 12 }).map((_, i) => <div key={i} className="skeleton h-[248px]" />)}
        </div>
      ) : isError ? (
        <div className="card flex flex-col items-center py-16 gap-3 text-center">
          <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: 'rgba(var(--danger-rgb),0.1)', border: '1px solid rgba(var(--danger-rgb),0.25)' }}>
            <AlertCircle size={20} strokeWidth={1.75} className="text-danger" />
          </div>
          <p className="font-display text-lg text-fg mt-1">{t('catalog.loadError')}</p>
          <p className="text-sm text-fg-2">{t('catalog.loadErrorHint')}</p>
          <button className="btn-secondary mt-2" onClick={() => refetch()}>{t('catalog.retry')}</button>
        </div>
      ) : modpacks.length === 0 ? (
        <div className="card flex flex-col items-center py-16 gap-2 text-center">
          <div className="w-12 h-12 rounded-xl flex items-center justify-center bg-surface-2 border border-line">
            <Search size={20} strokeWidth={1.75} className="text-fg-3" />
          </div>
          <p className="font-display text-lg text-fg mt-2">{t('catalog.noResults')}</p>
          {query && <p className="text-sm text-fg-2">{t('catalog.noResultsHint')}</p>}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
          {modpacks.map((mp, idx) => (
            <div key={`${mp.source}:${mp.id}`} className="card-in" style={{ animationDelay: `${Math.min(idx, 16) * 25}ms` }}>
              <ModpackCard modpack={mp} onDeploy={setDeployModpack} onDetail={setSelectedModpack} />
            </div>
          ))}
        </div>
      )}

      {selectedModpack && (
        <ModpackDetail
          modpack={selectedModpack}
          onClose={() => setSelectedModpack(null)}
          onDeploy={mp => { setSelectedModpack(null); setDeployModpack(mp); }}
        />
      )}
      {deployModpack && <DeployModal modpack={deployModpack} onClose={() => setDeployModpack(null)} />}
      <VanillaModal open={vanillaOpen} onClose={() => setVanillaOpen(false)} />
    </div>
  );
}

// Compteur compact façon « écran de contrôle » : chiffre en police pixel + bloc d'état
function StatCard({ label, value, color, live }) {
  return (
    <div className="card !p-0 min-w-[124px]">
      <div className="px-4 pt-3 pb-3.5">
        <div className="flex items-center gap-2">
          <span className={live ? 'status-block live' : 'status-block'} style={{ color, width: 7, height: 7 }} />
          <span className="text-[11px] text-fg-2 truncate">{label}</span>
        </div>
        <p className="font-pixel text-[28px] leading-none mt-2.5" style={{ color: value > 0 ? color : 'var(--fg-3)', textShadow: value > 0 && live ? `0 0 18px ${color}` : 'none' }}>
          {value}
        </p>
      </div>
    </div>
  );
}
