import React, { useState } from 'react';
import clsx from 'clsx';
import { useIconStore } from '../../store';
import { statusColor, STATUS_LIVE } from './status';

export default function ServerAvatar({ server, size = 32, showDot = true, className }) {
  const [imgFailed, setImgFailed] = useState(false);
  const iconV = useIconStore(s => s.versions[server.id] || 1);
  const initial = (server.name || '?')[0].toUpperCase();
  const blockSize = size <= 24 ? 7 : size <= 36 ? 8 : 10;
  const radius = Math.max(6, Math.round(size * 0.24));

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
          className="font-display font-bold text-fg-2 select-none flex items-center justify-center"
          style={{
            width: size,
            height: size,
            borderRadius: radius,
            fontSize: Math.round(size * 0.42),
            background: 'linear-gradient(145deg, var(--surface-3), var(--surface-2))',
            border: '1px solid var(--line)',
          }}
        >
          {initial}
        </div>
      )}
      {showDot && (
        <span
          className={clsx('status-block absolute', STATUS_LIVE.has(server.status) && 'live')}
          style={{
            width: blockSize,
            height: blockSize,
            right: -2,
            bottom: -2,
            color: statusColor(server.status),
            outline: '2px solid var(--bg-2)',
          }}
        />
      )}
    </div>
  );
}
