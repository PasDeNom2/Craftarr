import React from 'react';
import clsx from 'clsx';
import { useI18n } from '../../i18n';
import { statusColor, statusRgb, STATUS_LIVE } from './status';

export default function StatusBadge({ status, className, size = 'sm' }) {
  const { t } = useI18n();
  const rgb = statusRgb(status);

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-2 rounded-md font-medium whitespace-nowrap',
        size === 'lg' ? 'px-2.5 py-1 text-xs' : 'px-2 py-0.5 text-[11px]',
        className,
      )}
      style={{
        color: statusColor(status),
        background: `rgba(${rgb},0.09)`,
        border: `1px solid rgba(${rgb},0.22)`,
      }}
    >
      <span className={clsx('status-block', STATUS_LIVE.has(status) && 'live')} />
      {t(`server.status.${status}`)}
    </span>
  );
}
