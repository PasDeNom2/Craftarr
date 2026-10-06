import React, { useState } from 'react';
import SourceBadge from '../ui/SourceBadge';
import { useI18n } from '../../i18n';
import { Download, Server, Package } from 'lucide-react';

function formatCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function Thumb({ modpack }) {
  const [failed, setFailed] = useState(false);
  if (modpack.thumbnailUrl && !failed) {
    return (
      <img
        src={modpack.thumbnailUrl}
        alt=""
        loading="lazy"
        className="w-11 h-11 rounded-lg object-cover bg-surface-2 shrink-0"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <div className="w-11 h-11 rounded-lg bg-surface-2 border border-line flex items-center justify-center text-[15px] font-semibold text-fg-3 shrink-0">
      {modpack.name?.[0]?.toUpperCase() || <Package size={18} strokeWidth={1.5} />}
    </div>
  );
}

export default function ModpackCard({ modpack, onDeploy, onDetail }) {
  const { t } = useI18n();
  const versions = modpack.mcVersions?.slice(0, 2).join(', ');

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onDetail(modpack)}
      onKeyDown={e => { if (e.key === 'Enter') onDetail(modpack); }}
      className="card !p-4 card-interactive cursor-pointer flex flex-col h-[188px] group"
    >
      <div className="flex gap-3 min-w-0">
        <Thumb modpack={modpack} />
        <div className="min-w-0 flex-1">
          <h3 className="font-medium text-fg text-[14px] leading-snug truncate">{modpack.name}</h3>
          <div className="mt-1"><SourceBadge source={modpack.source} sourceName={modpack._sourceName} /></div>
        </div>
      </div>

      <p className="text-fg-2 text-[12.5px] leading-relaxed line-clamp-2 mt-3">{modpack.summary}</p>

      <div className="mt-auto flex items-center gap-3 text-[12px] text-fg-3 min-w-0">
        {modpack.downloadCount > 0 && (
          <span className="flex items-center gap-1 shrink-0" title={t('modpack.downloads')}>
            <Download size={12} strokeWidth={1.75} />
            {formatCount(modpack.downloadCount)}
          </span>
        )}
        {versions && <span className="truncate">MC {versions}</span>}
        {modpack.hasServerPack && (
          <span className="flex items-center gap-1 shrink-0" title="Server pack">
            <Server size={12} strokeWidth={1.75} />
          </span>
        )}
        <button
          className="btn-secondary !h-7 !px-2.5 !text-[12px] ml-auto shrink-0"
          onClick={e => { e.stopPropagation(); onDeploy(modpack); }}
        >
          {t('modpack.deploy')}
        </button>
      </div>
    </div>
  );
}
