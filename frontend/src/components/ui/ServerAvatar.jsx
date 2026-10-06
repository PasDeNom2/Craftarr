import React, { useState } from 'react';
import clsx from 'clsx';
import { useIconStore } from '../../store';
import { statusColor, STATUS_LIVE } from './status';

/** Icône du serveur (server-icon.png) ou initiale, avec point d'état optionnel. */
export default function ServerAvatar({ server, size = 32, showDot = true, className }) {
  const [imgFailed, setImgFailed] = useState(false);
  const iconV = useIconStore(s => s.versions[server.id] || 1);
  const initial = (server.name || '?')[0].toUpperCase();
  const dotSize = size <= 24 ? 7 : size <= 36 ? 8 : 10;
  const radius = Math.max(5, Math.round(size / 4.5));

  return (
    <div className={clsx('relative shrink-0 inline-flex', className)} style={{ width: size, height: size }}>
      {!imgFailed ? (
        <img
          src={`/api/servers/${server.id}/icon?v=${iconV}`}
          alt=""
          onError={() => setImgFailed(true)}
          style={{ width: size, height: size, borderRadius: radius, objectFit: 'cover', display: 'block', imageRendering: 'pixelated' }}
        />
      ) : (
        <div
          className="flex items-center justify-center font-semibold select-none text-fg-2 bg-surface-2 border border-line-strong"
          style={{ width: size, height: size, borderRadius: radius, fontSize: Math.round(size * 0.42) }}
        >
          {initial}
        </div>
      )}
      {showDot && (
        <span
          className={STATUS_LIVE.has(server.status) && server.status === 'running' ? 'pulse-dot' : ''}
          style={{
            position: 'absolute',
            bottom: -2,
            right: -2,
            width: dotSize,
            height: dotSize,
            borderRadius: '50%',
            background: statusColor(server.status),
            boxShadow: '0 0 0 2px var(--bg-2)',
          }}
        />
      )}
    </div>
  );
}
