import React, { useState } from 'react';
import Modal from '../ui/Modal';
import SourceBadge from '../ui/SourceBadge';
import { useQuery } from '@tanstack/react-query';
import { getModpackDetail, getModpackMods } from '../../services/api';
import { useI18n } from '../../i18n';
import ReactMarkdown from 'react-markdown';
import { Download, Gamepad2, ExternalLink, Rocket, Package, Search, X, Loader2, AlertCircle } from 'lucide-react';

export default function ModpackDetail({ modpack, onClose, onDeploy }) {
  const { t } = useI18n();
  const [tab, setTab] = useState('overview');
  const [imgIdx, setImgIdx] = useState(0);
  const [modSearch, setModSearch] = useState('');

  const TABS = [
    { key: 'overview', label: t('modpack.tabOverview') },
    { key: 'mods',     label: t('modpack.tabMods') },
  ];

  const { data: detail, isLoading } = useQuery({
    queryKey: ['modpack', modpack?.source, modpack?.id],
    queryFn: () => getModpackDetail(modpack.source, modpack.id),
    enabled: !!modpack,
  });

  const { data: modsData, isLoading: modsLoading, isError: modsError } = useQuery({
    queryKey: ['modpack-mods', modpack?.source, modpack?.id],
    queryFn: () => getModpackMods(modpack.source, modpack.id),
    enabled: !!modpack && tab === 'mods',
    staleTime: 300000,
  });

  const allMods = modsData?.mods || [];
  const filteredMods = modSearch.trim()
    ? allMods.filter(m =>
        m.name.toLowerCase().includes(modSearch.toLowerCase()) ||
        m.summary?.toLowerCase().includes(modSearch.toLowerCase())
      )
    : allMods;

  const screenshots = detail?.screenshots || modpack?.screenshots || [];

  if (!modpack) return null;

  return (
    <Modal open={!!modpack} onClose={onClose} title={detail?.name || modpack.name} size="xl">
      <div className="flex flex-col" style={{ height: '80vh', maxHeight: '720px' }}>

        {/* Header sticky */}
        <div className="px-6 pt-5 pb-0 shrink-0">
          {/* Modpack info */}
          {isLoading ? (
            <div className="flex items-center gap-3 mb-4">
              <div className="skeleton w-14 h-14 rounded-xl" />
              <div className="space-y-2 flex-1">
                <div className="skeleton h-4 w-48 rounded" />
                <div className="skeleton h-3 w-72 rounded" />
              </div>
            </div>
          ) : (
            <div className="flex gap-4 mb-4">
              {(detail?.thumbnailUrl || modpack.thumbnailUrl) && (
                <img
                  src={detail?.thumbnailUrl || modpack.thumbnailUrl}
                  alt={detail?.name || modpack.name}
                  className="w-14 h-14 rounded-xl object-cover shrink-0"
                  style={{ background: '#1C1C21' }}
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <h2 className="text-base font-semibold text-[#F0F0F0] truncate">{detail?.name || modpack.name}</h2>
                  <SourceBadge source={modpack.source} sourceName={modpack._sourceName} />
                </div>
                <p className="text-sm text-[#6B6B76] line-clamp-1">{detail?.summary || modpack.summary}</p>
                {detail?.authors?.length > 0 && (
                  <p className="text-xs text-[#4A4A55] mt-0.5">{t('modpack.by')} {detail.authors.join(', ')}</p>
                )}
                <div className="flex gap-4 text-xs text-[#4A4A55] mt-1 flex-wrap">
                  {(detail?.mcVersions || modpack.mcVersions)?.length > 0 && (
                    <span className="flex items-center gap-1">
                      <Gamepad2 size={11} strokeWidth={1.5} />
                      {(detail?.mcVersions || modpack.mcVersions).slice(0, 3).join(', ')}
                    </span>
                  )}
                  {(detail?.downloadCount || modpack.downloadCount) > 0 && (
                    <span className="flex items-center gap-1">
                      <Download size={11} strokeWidth={1.5} />
                      {((detail?.downloadCount || modpack.downloadCount) / 1000).toFixed(0)}k {t('modpack.downloads')}
                    </span>
                  )}
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-start gap-2 shrink-0">
                {detail?.websiteUrl && (
                  <a
                    href={detail.websiteUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-secondary gap-1.5 text-xs py-1.5 px-2.5"
                  >
                    <ExternalLink size={12} strokeWidth={1.5} />
                    {t('modpack.officialSite')}
                  </a>
                )}
                <button
                  className="btn-primary gap-1.5 text-xs py-1.5 px-2.5"
                  onClick={() => { onClose(); onDeploy(modpack); }}
                >
                  <Rocket size={12} strokeWidth={1.5} />
                  {t('modpack.deploy')}
                </button>
              </div>
            </div>
          )}

          {/* Tabs */}
          <div className="flex gap-0" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            {TABS.map(tb => (
              <button
                key={tb.key}
                onClick={() => setTab(tb.key)}
                className="relative px-4 py-2 text-xs font-medium transition-colors duration-150"
                style={{ color: tab === tb.key ? 'var(--accent)' : '#6B6B76' }}
              >
                {tb.label}
                {tb.key === 'mods' && allMods.length > 0 && (
                  <span
                    className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full"
                    style={{ background: 'rgba(74,222,128,0.1)', color: 'var(--accent)' }}
                  >
                    {allMods.length}
                  </span>
                )}
                {tab === tb.key && (
                  <span
                    className="absolute bottom-0 left-0 right-0 h-0.5 rounded-t-full"
                    style={{ background: 'var(--accent)' }}
                  />
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">

          {/* ── OVERVIEW TAB ── */}
          {tab === 'overview' && (
            <div className="space-y-5">
              {/* Screenshots */}
              {screenshots.length > 0 && (
                <div className="space-y-2">
                  <img
                    src={screenshots[imgIdx]}
                    alt="screenshot"
                    className="w-full rounded-xl object-cover"
                    style={{ maxHeight: '220px' }}
                  />
                  {screenshots.length > 1 && (
                    <div className="flex gap-2 overflow-x-auto pb-1">
                      {screenshots.map((s, i) => (
                        <img
                          key={i} src={s} alt=""
                          onClick={() => setImgIdx(i)}
                          className="w-14 h-14 rounded-lg object-cover cursor-pointer shrink-0 transition-opacity"
                          style={{
                            border: `2px solid ${i === imgIdx ? 'rgba(255,255,255,0.4)' : 'transparent'}`,
                            opacity: i === imgIdx ? 1 : 0.5,
                          }}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Description */}
              {isLoading ? (
                <div className="space-y-2">
                  {[...Array(6)].map((_, i) => (
                    <div key={i} className="skeleton h-3 rounded" style={{ width: `${60 + (i * 7) % 35}%` }} />
                  ))}
                </div>
              ) : detail?.description ? (
                detail.descriptionIsHtml ? (
                  <div
                    className="cf-description text-sm text-[#6B6B76] leading-relaxed"
                    dangerouslySetInnerHTML={{ __html: detail.description }}
                  />
                ) : (
                  <div className="text-sm text-[#6B6B76] leading-relaxed prose-sm prose-invert max-w-none">
                    <ReactMarkdown>{detail.description}</ReactMarkdown>
                  </div>
                )
              ) : (
                <p className="text-sm text-[#4A4A55] italic">{t('modpack.noDescription')}</p>
              )}
            </div>
          )}

          {/* ── MODS TAB ── */}
          {tab === 'mods' && (
            <div className="space-y-4">
              {/* Search bar */}
              <div className="relative">
                <Search size={13} strokeWidth={1.5} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#4A4A55] pointer-events-none" />
                <input
                  className="input pl-9 w-full text-sm"
                  placeholder={t('modpack.searchMod')}
                  value={modSearch}
                  onChange={e => setModSearch(e.target.value)}
                />
                {modSearch && (
                  <button
                    onClick={() => setModSearch('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[#4A4A55] hover:text-[#6B6B76] transition-colors"
                  >
                    <X size={12} strokeWidth={2} />
                  </button>
                )}
              </div>

              {/* States */}
              {modsLoading ? (
                <div className="flex flex-col items-center py-12 gap-3">
                  <Loader2 size={24} strokeWidth={1.5} className="text-[#4A4A55] animate-spin" />
                  <p className="text-sm text-[#6B6B76]">{t('modpack.modsLoading')}</p>
                  <p className="text-xs text-[#4A4A55]">{t('modpack.modsLoadingHint')}</p>
                </div>
              ) : modsError ? (
                <div className="flex flex-col items-center py-12 gap-3 text-center">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.15)' }}>
                    <AlertCircle size={18} strokeWidth={1.5} className="text-[#F87171]" />
                  </div>
                  <p className="text-sm text-[#F0F0F0] font-medium">{t('modpack.modsError')}</p>
                  <p className="text-xs text-[#6B6B76]">{t('modpack.modsErrorHint')}</p>
                </div>
              ) : filteredMods.length === 0 ? (
                <div className="flex flex-col items-center py-12 gap-2 text-center">
                  <Package size={24} strokeWidth={1.5} className="text-[#4A4A55]" />
                  <p className="text-sm text-[#6B6B76]">
                    {modSearch ? t('modpack.modsNoMatch').replace('{search}', modSearch) : t('modpack.modsEmpty')}
                  </p>
                </div>
              ) : (
                <>
                  <p className="text-xs text-[#4A4A55]">
                    {modSearch
                      ? t('modpack.modsResults').replace('{count}', filteredMods.length).replace('{total}', allMods.length)
                      : t('modpack.modsCount').replace('{count}', allMods.length)}
                  </p>
                  <div className="space-y-2">
                    {filteredMods.map(mod => (
                      <ModRow key={mod.id} mod={mod} />
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function ModRow({ mod }) {
  return (
    <div
      className="flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors duration-150"
      style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}
      onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.04)'}
      onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}
    >
      {/* Icon */}
      {mod.thumbnailUrl ? (
        <img
          src={mod.thumbnailUrl}
          alt={mod.name}
          className="w-9 h-9 rounded-lg object-cover shrink-0"
          style={{ background: '#1C1C21' }}
          onError={e => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'flex'; }}
        />
      ) : null}
      <div
        className="w-9 h-9 rounded-lg shrink-0 items-center justify-center text-xs font-bold text-[#4A4A55]"
        style={{
          background: '#1C1C21',
          border: '1px solid rgba(255,255,255,0.06)',
          display: mod.thumbnailUrl ? 'none' : 'flex',
        }}
      >
        {mod.name[0]?.toUpperCase()}
      </div>

      {/* Info */}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-[#F0F0F0] truncate">{mod.name}</p>
        {mod.summary && (
          <p className="text-xs text-[#4A4A55] truncate leading-relaxed">{mod.summary}</p>
        )}
      </div>

      {/* Downloads */}
      {mod.downloadCount > 0 && (
        <span className="text-[11px] text-[#4A4A55] flex items-center gap-1 shrink-0">
          <Download size={10} strokeWidth={1.5} />
          {mod.downloadCount >= 1_000_000
            ? `${(mod.downloadCount / 1_000_000).toFixed(1)}M`
            : mod.downloadCount >= 1000
            ? `${(mod.downloadCount / 1000).toFixed(0)}k`
            : mod.downloadCount}
        </span>
      )}

      {/* Link */}
      {mod.websiteUrl && (
        <a
          href={mod.websiteUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-[#4A4A55] hover:text-[#F0F0F0] transition-colors"
          onClick={e => e.stopPropagation()}
        >
          <ExternalLink size={13} strokeWidth={1.5} />
        </a>
      )}
    </div>
  );
}
