import React from 'react';
import clsx from 'clsx';
import { useI18n } from '../../i18n';

const STATUS_STYLE = {
  running:    { dot: 'var(--accent)', text: 'var(--accent)',  bg: 'rgba(var(--accent-rgb),0.08)',  border: 'rgba(var(--accent-rgb),0.2)'  },
  starting:   { dot: 'var(--warn)', text: 'var(--warn)',  bg: 'rgba(var(--warn-rgb),0.08)',  border: 'rgba(var(--warn-rgb),0.2)'  },
  stopped:    { dot: 'var(--fg-2)', text: 'var(--fg-2)',  bg: 'rgba(var(--fg-2-rgb),0.08)', border: 'rgba(var(--fg-2-rgb),0.2)' },
  installing: { dot: 'var(--warn)', text: 'var(--warn)',  bg: 'rgba(var(--warn-rgb),0.08)',  border: 'rgba(var(--warn-rgb),0.2)'  },
  updating:   { dot: 'var(--warn)', text: 'var(--warn)',  bg: 'rgba(var(--warn-rgb),0.08)',  border: 'rgba(var(--warn-rgb),0.2)'  },
  error:      { dot: 'var(--danger)', text: 'var(--danger)',  bg: 'rgba(var(--danger-rgb),0.08)', border: 'rgba(var(--danger-rgb),0.2)' },
};

export default function StatusBadge({ status, className }) {
  const { t } = useI18n();
  const s = STATUS_STYLE[status] || STATUS_STYLE.stopped;

  return (
    <span
      className={clsx('inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium', className)}
      style={{ color: s.text, background: s.bg, border: `1px solid ${s.border}` }}
    >
      <span
        className={clsx('w-1.5 h-1.5 rounded-full shrink-0', status === 'running' && 'pulse-dot')}
        style={{ backgroundColor: s.dot }}
      />
      {t(`server.status.${status}`, t('server.status.stopped'))}
    </span>
  );
}
