import React from 'react';
import clsx from 'clsx';
import { useI18n } from '../../i18n';
import { statusColor } from './status';

/** Badge d'état : point de couleur + libellé, sur fond neutre. */
export default function StatusBadge({ status, className }) {
  const { t } = useI18n();
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 h-6 px-2 rounded-md text-[12px] font-medium text-fg-2 border border-line bg-surface',
        className,
      )}
    >
      <span
        className={clsx('w-1.5 h-1.5 rounded-full shrink-0', status === 'running' && 'pulse-dot')}
        style={{ backgroundColor: statusColor(status) }}
      />
      {t(`server.status.${status}`, t('server.status.stopped'))}
    </span>
  );
}
