import React, { useState } from 'react';
import clsx from 'clsx';
import { useIconStore } from '../../store';

const STATUS_COLOR = {
  running:    '#4ADE80',
  stopped:    '#F87171',
  error:      '#F87171',
  starting:   '#FBBF24',
  installing: '#FBBF24',
  updating:   '#FBBF24',
};

const STATUS_PULSE = {
  running:    true,
  starting:   true,
  installing: true,
  updating:   true,
};

export default function ServerAvatar({ server, size = 32, showDot = true, className }) {
  const [imgFailed, setImgFailed] = useState(false);
  const iconV = useIconStore(s => s.versions[server.id] || 1);
  const initial = (server.name || '?')[0].toUpperCase();
  const dotColor = STATUS_COLOR[server.status] || STATUS_COLOR.stopped;
  const pulse = STATUS_PULSE[server.status];
  const dotSize = size <= 24 ? 7 : size <= 36 ? 9 : 11;
  const fontSize = Math.round(size * 0.4);

  return (
    <div
      className={clsx('relative shrink-0 inline-flex', className)}
      style={{ width: size, height: size }}
    >
      {!imgFailed ? (
        <img
          src={`/api/servers/${server.id}/icon?v=${iconV}`}
          alt={server.name}
          onError={() => setImgFailed(true)}
          style={{ width: size, height: size, borderRadius: 8, objectFit: 'cover', display: 'block' }}
        />
      ) : (
        <div
          style={{
            width: size,
            height: size,
            borderRadius: 8,
            background: 'rgba(255,255,255,0.07)',
            border: '1px solid rgba(255,255,255,0.10)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize,
            fontWeight: 700,
            color: '#6B6B76',
            userSelect: 'none',
          }}
        >
          {initial}
        </div>
      )}
      {showDot && (
        <span
          className={pulse ? 'pulse-dot' : ''}
          style={{
            position: 'absolute',
            bottom: -2,
            right: -2,
            width: dotSize,
            height: dotSize,
            borderRadius: '50%',
            background: dotColor,
            border: '1.5px solid var(--bg-sidebar)',
            display: 'block',
          }}
        />
      )}
    </div>
  );
}
