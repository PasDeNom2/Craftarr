import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getCatalog } from '../services/api';
import { useServerStore } from '../store';
import { useI18n } from '../i18n';
import ModpackCard from '../components/catalog/ModpackCard';
import ModpackDetail from '../components/catalog/ModpackDetail';
import DeployModal from '../components/catalog/DeployModal';
import VanillaModal from '../components/catalog/VanillaModal';
import { Search, X, AlertCircle, Activity, Server, Loader, Box, SlidersHorizontal, ChevronDown } from 'lucide-react';

const MC_VERSIONS = ['1.21.4', '1.21.1', '1.21', '1.20.4', '1.20.1', '1.19.4', '1.19.2', '1.18.2', '1.16.5', '1.12.2', '1.7.10'];
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
  mcVersion: { bg: 'rgba(74,222,128,0.08)', border: 'rgba(74,222,128,0.25)', text: '#4ADE80',  dot: '#4ADE80' },
  category:  { bg: 'rgba(167,139,250,0.08)', border: 'rgba(167,139,250,0.25)', text: '#A78BFA', dot: '#A78BFA' },
source:    { bg: 'rgba(251,191,36,0.08)', border: 'rgba(251,191,36,0.25)', text: '#FBBF24',  dot: '#FBBF24' },
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
      className="absolute right-0 top-full mt-2 rounded-xl z-50 flex flex-col"
      style={{
        width: '340px',
        background: '#18181C',
        border: '1px solid rgba(255,255,255,0.1)',
        boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
        maxHeight: '520px',
        overflowY: 'auto',
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 sticky top-0" style={{ background: '#18181C', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <span className="text-xs font-semibold text-[#F0F0F0] uppercase tracking-widest">{t('catalog.filters')}</span>
        {totalActive > 0 && (
          <button onClick={onClear} className="text-[11px] text-[#F87171] hover:text-red-400 transition-colors">
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
                <p className="text-[11px] font-semibold text-[#4A4A55] uppercase tracking-widest">{def.label}</p>
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
                        color: active ? col.text : '#6B6B76',
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
    <div className="p-7 max-w-screen-xl mx-auto">
      <div className="mb-7">
        <h1 className="text-xl font-semibold text-[#F0F0F0] tracking-tight">{t('catalog.title')}</h1>
        <p className="text-sm text-[#6B6B76] mt-1">{t('catalog.subtitle')}</p>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-7">
        <StatCard
          icon={Activity}
          label={t('catalog.activeServers')}
          value={runningCount}
          accent={runningCount > 0}
          sub={runningCount > 0 ? `${runningCount} ${t('catalog.online')}` : t('catalog.noneActive')}
        />
        <StatCard
          icon={Server}
          label={t('catalog.stoppedServers')}
          value={stoppedCount}
          sub={`${servers.length} ${t('catalog.totalServers')}`}
        />
        <StatCard
          icon={Loader}
          label={t('catalog.inProgress')}
          value={installingCount}
          sub={installingCount > 0 ? t('catalog.installing') : t('catalog.noneInProgress')}
        />
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-sm font-semibold text-[#F0F0F0] uppercase tracking-[0.08em]">{t('catalog.available')}</h2>
          <div className="flex items-center gap-3">
            <span className="text-xs text-[#6B6B76]">{modpacks.length} {t('catalog.results')}</span>
            <button
              onClick={() => setVanillaOpen(true)}
              className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg transition-all duration-200"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: '#6B6B76' }}
              onMouseEnter={e => { e.currentTarget.style.color = '#F0F0F0'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.16)'; }}
              onMouseLeave={e => { e.currentTarget.style.color = '#6B6B76'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; }}
              title={t('catalog.vanillaHint')}
            >
              <Box size={12} strokeWidth={1.5} />
              {t('catalog.vanilla')}
            </button>
          </div>
        </div>

        {/* Search bar + filter button */}
        <form onSubmit={handleSearch} className="flex gap-3 mb-3">
          <div className="flex-1 relative">
            <Search size={14} strokeWidth={1.5} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#4A4A55] pointer-events-none" />
            <input
              className="input pl-9 w-full"
              placeholder={t('catalog.search')}
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
            />
          </div>

          {/* Filters button */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setFilterOpen(o => !o)}
              className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg h-full transition-all duration-200 font-medium whitespace-nowrap"
              style={{
                background: totalFilterCount > 0 ? 'rgba(74,222,128,0.08)' : 'rgba(255,255,255,0.04)',
                border: `1px solid ${totalFilterCount > 0 ? 'rgba(74,222,128,0.25)' : 'rgba(255,255,255,0.08)'}`,
                color: totalFilterCount > 0 ? '#4ADE80' : '#6B6B76',
              }}
            >
              <SlidersHorizontal size={13} strokeWidth={1.5} />
              {t('catalog.filters')}
              {totalFilterCount > 0 && (
                <span
                  className="flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold"
                  style={{ background: 'var(--accent)', color: 'var(--bg)' }}
                >
                  {totalFilterCount}
                </span>
              )}
              <ChevronDown
                size={11}
                strokeWidth={2}
                style={{ transform: filterOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}
              />
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

          {hasActiveSearch && (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => { setQuery(''); setInputValue(''); setActiveFilters({}); }}
            >
              <X size={13} strokeWidth={1.5} />
              {t('catalog.clear')}
            </button>
          )}
        </form>

        {/* Active filter chips — une chip par valeur sélectionnée */}
        {totalFilterCount > 0 && (
          <div className="flex flex-wrap gap-2 mb-4">
            {Object.entries(activeFilters).flatMap(([key, values]) => {
              const col = FILTER_COLORS[key];
              const def = filterDefs.find(d => d.key === key);
              return values.map(value => {
                const label = def?.options.find(o => o.value === value)?.label || value;
                return (
                  <span
                    key={`${key}:${value}`}
                    className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium"
                    style={{ background: col.bg, border: `1px solid ${col.border}`, color: col.text }}
                  >
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: col.dot }} />
                    {def?.label} : {label}
                    <button
                      onClick={() => removeFilterValue(key, value)}
                      className="ml-0.5 hover:opacity-70 transition-opacity"
                      type="button"
                    >
                      <X size={10} strokeWidth={2.5} />
                    </button>
                  </span>
                );
              });
            })}
          </div>
        )}

        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="skeleton h-48 rounded-xl" />
            ))}
          </div>
        ) : isError ? (
          <div className="flex flex-col items-center py-16 gap-3 text-center">
            <div
              className="w-11 h-11 rounded-xl flex items-center justify-center"
              style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)' }}
            >
              <AlertCircle size={20} strokeWidth={1.5} className="text-[#F87171]" />
            </div>
            <p className="font-medium text-[#F0F0F0] text-sm">{t('catalog.loadError')}</p>
            <p className="text-sm text-[#6B6B76]">{t('catalog.loadErrorHint')}</p>
            <button className="btn-secondary mt-1" onClick={() => refetch()}>{t('catalog.retry')}</button>
          </div>
        ) : modpacks.length === 0 ? (
          <div className="flex flex-col items-center py-16 gap-2 text-center">
            <div
              className="w-11 h-11 rounded-xl flex items-center justify-center"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
            >
              <Search size={18} strokeWidth={1.5} className="text-[#4A4A55]" />
            </div>
            <p className="font-medium text-[#F0F0F0] text-sm mt-1">{t('catalog.noResults')}</p>
            {query && <p className="text-sm text-[#6B6B76]">{t('catalog.noResultsHint')}</p>}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {modpacks.map((mp, idx) => (
              <div key={`${mp.source}:${mp.id}`} className="card-in" style={{ animationDelay: `${idx * 30}ms` }}>
                <ModpackCard
                  modpack={mp}
                  onDeploy={setDeployModpack}
                  onDetail={setSelectedModpack}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {selectedModpack && (
        <ModpackDetail
          modpack={selectedModpack}
          onClose={() => setSelectedModpack(null)}
          onDeploy={mp => { setSelectedModpack(null); setDeployModpack(mp); }}
        />
      )}
      {deployModpack && (
        <DeployModal
          modpack={deployModpack}
          onClose={() => setDeployModpack(null)}
        />
      )}
      <VanillaModal open={vanillaOpen} onClose={() => setVanillaOpen(false)} />
    </div>
  );
}

function StatCard({ icon: Icon, label, value, sub, accent }) {
  return (
    <div className="card flex flex-col gap-3">
      <div
        className="w-8 h-8 rounded-lg flex items-center justify-center"
        style={{
          background: accent ? 'rgba(var(--accent-rgb),0.1)' : 'rgba(255,255,255,0.04)',
          border: accent ? '1px solid rgba(var(--accent-rgb),0.2)' : '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <Icon size={15} strokeWidth={1.5} style={{ color: accent ? 'var(--accent)' : '#6B6B76' }} />
      </div>
      <div>
        <p className="text-[#6B6B76] text-xs uppercase tracking-[0.08em] font-medium">{label}</p>
        <p className="text-[28px] font-semibold text-[#F0F0F0] tracking-tight leading-none mt-1">{value}</p>
      </div>
      {sub && (
        <p className="text-xs" style={{ color: accent ? 'var(--accent)' : '#6B6B76' }}>{sub}</p>
      )}
    </div>
  );
}
