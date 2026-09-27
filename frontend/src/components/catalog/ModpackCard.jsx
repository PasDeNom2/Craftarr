import React, { useState } from 'react';
import { Download, Gamepad2, ShieldCheck, Rocket, Package } from 'lucide-react';
import SourceBadge from '../ui/SourceBadge';
import { useI18n } from '../../i18n';

function formatCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

export default function ModpackCard({ modpack, onDeploy, onDetail }) {
  const { t } = useI18n();
  const [imgFailed, setImgFailed] = useState(!modpack.thumbnailUrl);

  return (
    <article
      className="group card card-interactive !p-0 h-[248px] flex flex-col overflow-hidden cursor-pointer"
      onClick={() => onDetail(modpack)}
    >
      {/* Bandeau : vignette floutée en fond pour donner la couleur du pack */}
      <div className="relative h-[76px] shrink-0 overflow-hidden">
        {!imgFailed && (
          <img
            src={modpack.thumbnailUrl}
            alt=""
            aria-hidden="true"
            className="absolute inset-0 w-full h-full object-cover scale-150 blur-2xl opacity-40 group-hover:opacity-60 transition-opacity duration-500"
          />
        )}
        <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, transparent 20%, var(--surface) 100%)' }} />
        <div className="absolute left-4 top-4 flex items-start gap-3 right-4">
          {!imgFailed ? (
            <img
              src={modpack.thumbnailUrl}
              alt={modpack.name}
              onError={() => setImgFailed(true)}
              className="w-14 h-14 rounded-xl object-cover shrink-0 transition-transform duration-300 group-hover:scale-105"
              style={{ boxShadow: '0 8px 20px -6px rgba(0,0,0,0.7), 0 0 0 1px var(--line)' }}
            />
          ) : (
            <div className="w-14 h-14 rounded-xl shrink-0 flex items-center justify-center font-display text-xl font-bold text-fg-3 bg-surface-2 border border-line">
              {modpack.name?.[0]?.toUpperCase() || <Package size={20} strokeWidth={1.5} />}
            </div>
          )}
          <div className="min-w-0 pt-0.5 flex-1">
            <h3 className="font-display font-semibold text-fg text-[15px] leading-snug truncate" title={modpack.name}>{modpack.name}</h3>
            <div className="mt-1"><SourceBadge source={modpack.source} sourceName={modpack._sourceName} /></div>
          </div>
        </div>
      </div>

      <div className="flex-1 flex flex-col px-4 pt-3 pb-4 min-h-0">
        <p className="text-fg-2 text-[13px] line-clamp-2 leading-relaxed">{modpack.summary}</p>

        <div className="flex items-center gap-3 text-[11px] text-fg-3 mt-3 font-mono">
          {modpack.downloadCount > 0 && (
            <span className="flex items-center gap-1" title={String(modpack.downloadCount)}>
              <Download size={11} strokeWidth={1.75} /> {formatCount(modpack.downloadCount)}
            </span>
          )}
          {modpack.mcVersions?.length > 0 && (
            <span className="flex items-center gap-1 truncate">
              <Gamepad2 size={11} strokeWidth={1.75} /> {modpack.mcVersions.slice(0, 2).join(', ')}
            </span>
          )}
          {modpack.hasServerPack && (
            <span className="flex items-center gap-1 text-accent" title="Server pack">
              <ShieldCheck size={11} strokeWidth={1.75} /> Server
            </span>
          )}
        </div>

        {modpack.categories?.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2.5 overflow-hidden max-h-[22px]">
            {modpack.categories.slice(0, 4).map(cat => (
              <span key={cat} className="text-[10px] px-1.5 py-0.5 rounded-md text-fg-2 bg-surface-2 border border-line whitespace-nowrap">
                {cat}
              </span>
            ))}
          </div>
        )}

        <button
          className="btn mt-auto w-full justify-center text-[13px] py-2 font-semibold bg-surface-2 border border-line text-fg
                     group-hover:bg-accent group-hover:text-accent-ink group-hover:border-transparent"
          onClick={e => { e.stopPropagation(); onDeploy(modpack); }}
        >
          <Rocket size={14} strokeWidth={2} />
          {t('modpack.deploy')}
        </button>
      </div>
    </article>
  );
}
