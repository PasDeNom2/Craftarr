import React, { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getCatalog } from '../services/api';
import { useServerStore } from '../store';
import { useI18n } from '../i18n';
import ModpackCard from '../components/catalog/ModpackCard';
import ModpackDetail from '../components/catalog/ModpackDetail';
import DeployModal from '../components/catalog/DeployModal';
import VanillaModal from '../components/catalog/VanillaModal';
import { Search, X, AlertCircle, Activity, Server, Loader, Box } from 'lucide-react';

const MC_VERSIONS = ['1.21', '1.20.4', '1.20.1', '1.19.2', '1.18.2', '1.16.5', '1.12.2'];

export default function CatalogPage() {
  const [query, setQuery] = useState('');
  const [inputValue, setInputValue] = useState('');
  const [mcVersion, setMcVersion] = useState('');
  const [selectedModpack, setSelectedModpack] = useState(null);
  const [deployModpack, setDeployModpack] = useState(null);
  const [vanillaOpen, setVanillaOpen] = useState(false);
  const { t } = useI18n();

  const servers = useServerStore(s => s.servers);
  const runningCount = servers.filter(s => s.status === 'running').length;
  const stoppedCount = servers.filter(s => s.status === 'stopped').length;
  const installingCount = servers.filter(s => ['installing', 'updating'].includes(s.status)).length;

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['catalog', query, mcVersion],
    queryFn: () => getCatalog({ query, mcVersion: mcVersion || undefined, limit: 40 }),
    staleTime: 60000,
  });

  const modpacks = data?.data || [];

  const handleSearch = useCallback((e) => {
    e.preventDefault();
    setQuery(inputValue.trim());
  }, [inputValue]);

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

        <form onSubmit={handleSearch} className="flex gap-3 mb-5 flex-wrap">
          <div className="flex-1 min-w-60 relative">
            <Search size={14} strokeWidth={1.5} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#4A4A55]" />
            <input
              className="input pl-9"
              placeholder={t('catalog.search')}
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
            />
          </div>
          <select
            className="input w-44"
            value={mcVersion}
            onChange={e => setMcVersion(e.target.value)}
          >
            <option value="">{t('catalog.allVersions')}</option>
            {MC_VERSIONS.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
          {(query || mcVersion) && (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => { setQuery(''); setInputValue(''); setMcVersion(''); }}
            >
              <X size={13} strokeWidth={1.5} />
              {t('catalog.clear')}
            </button>
          )}
        </form>

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
