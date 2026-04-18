import React from 'react';
import SourceBadge from '../ui/SourceBadge';
import { useI18n } from '../../i18n';
import { Download, Gamepad2, CheckCircle, Rocket, Package } from 'lucide-react';

function formatCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

export default function ModpackCard({ modpack, onDeploy, onDetail }) {
  const { t } = useI18n();
  return (
    <div
      className="flex flex-col gap-3 p-4 rounded-xl cursor-pointer group"
      style={{
        background: '#131316',
        border: '1px solid rgba(255,255,255,0.06)',
        transition: 'border-color 0.2s, background 0.2s',
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)'; e.currentTarget.style.background = '#1C1C21'; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)'; e.currentTarget.style.background = '#131316'; }}
      onClick={() => onDetail(modpack)}
    >
      {/* Header */}
      <div className="flex gap-3">
        {modpack.thumbnailUrl ? (
          <img
            src={modpack.thumbnailUrl}
            alt={modpack.name}
            className="w-12 h-12 rounded-lg object-cover shrink-0"
            style={{ background: '#1C1C21' }}
            onError={e => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'flex'; }}
          />
        ) : null}
        <div
          className="w-12 h-12 rounded-lg shrink-0 items-center justify-center text-base font-bold text-[#4A4A55]"
          style={{
            background: '#1C1C21',
            border: '1px solid rgba(255,255,255,0.06)',
            display: modpack.thumbnailUrl ? 'none' : 'flex',
          }}
        >
          {modpack.name?.[0]?.toUpperCase() || <Package size={18} strokeWidth={1.5} />}
        </div>
        <div className="min-w-0">
          <div className="flex items-start gap-2 flex-wrap mb-1">
            <h3 className="font-medium text-[#F0F0F0] text-sm leading-tight truncate">
              {modpack.name}
            </h3>
            <SourceBadge source={modpack.source} sourceName={modpack._sourceName} />
          </div>
          <p className="text-[#6B6B76] text-xs line-clamp-2 leading-relaxed">{modpack.summary}</p>
        </div>
      </div>

      {/* Meta */}
      <div className="flex items-center gap-3 text-[11px] text-[#4A4A55]">
        {modpack.downloadCount > 0 && (
          <span className="flex items-center gap-1">
            <Download size={10} strokeWidth={1.5} />
            {formatCount(modpack.downloadCount)}
          </span>
        )}
        {modpack.mcVersions?.length > 0 && (
          <span className="flex items-center gap-1">
            <Gamepad2 size={10} strokeWidth={1.5} />
            {modpack.mcVersions.slice(0, 2).join(', ')}
          </span>
        )}
        {modpack.hasServerPack && (
          <span className="flex items-center gap-1 text-[#4ADE80]">
            <CheckCircle size={10} strokeWidth={1.5} />
            Serverpack
          </span>
        )}
      </div>

      {/* Categories */}
      {modpack.categories?.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {modpack.categories.slice(0, 3).map(cat => (
            <span
              key={cat}
              className="text-[10px] px-1.5 py-0.5 rounded-md text-[#6B6B76]"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
            >
              {cat}
            </span>
          ))}
        </div>
      )}

      {/* Deploy button */}
      <button
        className="btn-primary mt-auto w-full justify-center text-xs py-2 gap-2"
        onClick={e => { e.stopPropagation(); onDeploy(modpack); }}
      >
        <Rocket size={12} strokeWidth={1.5} />
        {t('modpack.deploy')}
      </button>
    </div>
  );
}
