import React from 'react';
import clsx from 'clsx';
import { useI18n } from '../../i18n';

const STATUS_STYLE = {
  running:    { dot: 'var(--accent)', text: 'var(--accent)',  bg: 'rgba(var(--accent-rgb),0.08)',  border: 'rgba(var(--accent-rgb),0.2)'  },
  starting:   { dot: '#FBBF24', text: '#FBBF24',  bg: 'rgba(251,191,36,0.08)',  border: 'rgba(251,191,36,0.2)'  },
  stopped:    { dot: '#6B6B76', text: '#6B6B76',  bg: 'rgba(107,107,118,0.08)', border: 'rgba(107,107,118,0.2)' },
  installing: { dot: '#FBBF24', text: '#FBBF24',  bg: 'rgba(251,191,36,0.08)',  border: 'rgba(251,191,36,0.2)'  },
  updating:   { dot: '#FBBF24', text: '#FBBF24',  bg: 'rgba(251,191,36,0.08)',  border: 'rgba(251,191,36,0.2)'  },
  error:      { dot: '#F87171', text: '#F87171',  bg: 'rgba(248,113,113,0.08)', border: 'rgba(248,113,113,0.2)' },
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
