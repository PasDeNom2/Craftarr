import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getCatalog } from '../services/api';
import { useI18n } from '../i18n';
import ModpackCard from '../components/catalog/ModpackCard';
import ModpackDetail from '../components/catalog/ModpackDetail';
import DeployModal from '../components/catalog/DeployModal';
import VanillaModal from '../components/catalog/VanillaModal';
import { Search, X, AlertCircle, Box, SlidersHorizontal, ChevronDown } from 'lucide-react';
import PageHeader, { Page } from '../components/layout/PageHeader';

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

// activeFilters = { mcVersion: ['1.21', '1.20.1'], category: ['adventure'], source: ['modrinth'] }
function FilterPanel({ activeFilters, onToggle, onClear, onClose, filterDefs, t }) {
  const ref = useRef(null);
  const totalActive = Object.values(activeFilters).reduce((n, arr) => n + arr.length, 0);

  useEffect(() => {
    function onClick(e) { if (ref.current && !ref.current.contains(e.target)) onClose(); }
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onClick); document.removeEventListener('keydown', onKey); };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="glass-strong absolute right-0 top-full mt-2 rounded-xl z-50 flex flex-col pop-in w-[340px] max-h-[520px] overflow-y-auto"
    >
      <div className="flex items-center justify-between px-4 h-11 sticky top-0 z-10 bg-surface-3 border-b border-line">
        <span className="text-[13px] font-medium text-fg">{t('catalog.filters')}</span>
        {totalActive > 0 && (
          <button onClick={onClear} className="text-[12px] text-fg-2 hover:text-fg transition-colors">
            {t('catalog.filtersClear')} ({totalActive})
          </button>
        )}
      </div>

      <div className="p-4 flex flex-col gap-5">
        {filterDefs.map(def => {
          const selected = activeFilters[def.key] || [];
          return (
            <div key={def.key}>
              <p className="eyebrow mb-2">{def.label}</p>
              <div className="flex flex-wrap gap-1.5">
                {def.options.map(opt => {
                  const active = selected.includes(opt.value);
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      aria-pressed={active}
                      onClick={() => onToggle(def.key, opt.value)}
                      className={active
                        ? 'text-[12px] h-7 px-2.5 rounded-md font-medium bg-fg text-inverse border border-fg'
                        : 'text-[12px] h-7 px-2.5 rounded-md font-medium text-fg-2 border border-line-strong hover:text-fg hover:border-fg-3 transition-colors'}
                    >
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

  // Recherche pendant la frappe (après une courte pause), Entrée reste immédiat
  useEffect(() => {
    const id = setTimeout(() => setQuery(inputValue.trim()), 400);
    return () => clearTimeout(id);
  }, [inputValue]);

  const hasActiveSearch = query || totalFilterCount > 0;

  return (
    <Page wide>
      <PageHeader
        title={t('catalog.title')}
        description={t('catalog.subtitle')}
        actions={(
          <button onClick={() => setVanillaOpen(true)} className="btn-secondary" title={t('catalog.vanillaHint')}>
            <Box size={14} strokeWidth={1.75} /> {t('catalog.vanillaServer')}
          </button>
        )}
      />

      {/* Recherche + filtres */}
      <form onSubmit={handleSearch} className="flex gap-2 mb-3">
        <div className="flex-1 relative">
          <Search size={15} strokeWidth={1.75} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-3 pointer-events-none" />
          <input
            className="input !h-10 pl-9 w-full"
            placeholder={t('catalog.search')}
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
          />
        </div>

        <div className="relative">
          <button
            type="button"
            onClick={() => setFilterOpen(o => !o)}
            aria-expanded={filterOpen}
            className="btn-secondary !h-10"
          >
            <SlidersHorizontal size={14} strokeWidth={1.75} />
            {t('catalog.filters')}
            {totalFilterCount > 0 && (
              <span className="flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10.5px] font-semibold bg-fg text-inverse">
                {totalFilterCount}
              </span>
            )}
            <ChevronDown size={13} strokeWidth={2} className={filterOpen ? 'rotate-180 transition-transform' : 'transition-transform'} />
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
            className="btn-ghost !h-10"
            onClick={() => { setQuery(''); setInputValue(''); setActiveFilters({}); }}
          >
            <X size={14} strokeWidth={1.75} />
            {t('catalog.clear')}
          </button>
        )}
      </form>

      {/* Filtres actifs + nombre de résultats */}
      <div className="flex flex-wrap items-center gap-1.5 mb-5 min-h-[28px]">
        {Object.entries(activeFilters).flatMap(([key, values]) => {
          const def = filterDefs.find(d => d.key === key);
          return values.map(value => {
            const label = def?.options.find(o => o.value === value)?.label || value;
            return (
              <span key={`${key}:${value}`} className="inline-flex items-center gap-1.5 h-7 pl-2.5 pr-1 rounded-md text-[12px] border border-line-strong text-fg-2">
                <span className="text-fg-3">{def?.label}</span>
                <span className="text-fg">{label}</span>
                <button onClick={() => removeFilterValue(key, value)} className="icon-btn !h-5 !min-w-5 !px-0" type="button" aria-label={t('catalog.clear')}>
                  <X size={11} strokeWidth={2} />
                </button>
              </span>
            );
          });
        })}
        {!isLoading && !isError && (
          <span className="text-[12.5px] text-fg-3 ml-auto">{modpacks.length} {t('catalog.results')}</span>
        )}
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-3">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="skeleton h-[188px] !rounded-xl" />
          ))}
        </div>
      ) : isError ? (
        <div className="card flex flex-col items-center py-16 gap-2 text-center">
          <AlertCircle size={22} strokeWidth={1.5} className="text-danger mb-1" />
          <p className="font-medium text-fg text-[14px]">{t('catalog.loadError')}</p>
          <p className="text-[13px] text-fg-2">{t('catalog.loadErrorHint')}</p>
          <button className="btn-secondary mt-3" onClick={() => refetch()}>{t('catalog.retry')}</button>
        </div>
      ) : modpacks.length === 0 ? (
        <div className="card flex flex-col items-center py-16 gap-2 text-center">
          <Search size={20} strokeWidth={1.5} className="text-fg-3 mb-1" />
          <p className="font-medium text-fg text-[14px]">{t('catalog.noResults')}</p>
          {query && <p className="text-[13px] text-fg-2">{t('catalog.noResultsHint')}</p>}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-3 stagger">
          {modpacks.map(mp => (
            <ModpackCard
              key={`${mp.source}:${mp.id}`}
              modpack={mp}
              onDeploy={setDeployModpack}
              onDetail={setSelectedModpack}
            />
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
      {deployModpack && (
        <DeployModal
          modpack={deployModpack}
          onClose={() => setDeployModpack(null)}
        />
      )}
      <VanillaModal open={vanillaOpen} onClose={() => setVanillaOpen(false)} />
    </Page>
  );
}
