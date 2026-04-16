import React from 'react';
import clsx from 'clsx';

const STATUS = {
  running:    { label: 'En ligne',     dot: '#4ADE80', text: '#4ADE80',  bg: 'rgba(74,222,128,0.08)',  border: 'rgba(74,222,128,0.2)'  },
  starting:   { label: 'Démarrage',   dot: '#FBBF24', text: '#FBBF24',  bg: 'rgba(251,191,36,0.08)',  border: 'rgba(251,191,36,0.2)'  },
  stopped:    { label: 'Arrêté',       dot: '#6B6B76', text: '#6B6B76',  bg: 'rgba(107,107,118,0.08)', border: 'rgba(107,107,118,0.2)' },
  installing: { label: 'Installation', dot: '#FBBF24', text: '#FBBF24',  bg: 'rgba(251,191,36,0.08)',  border: 'rgba(251,191,36,0.2)'  },
  updating:   { label: 'Mise à jour',  dot: '#FBBF24', text: '#FBBF24',  bg: 'rgba(251,191,36,0.08)',  border: 'rgba(251,191,36,0.2)'  },
  error:      { label: 'Erreur',       dot: '#F87171', text: '#F87171',  bg: 'rgba(248,113,113,0.08)', border: 'rgba(248,113,113,0.2)' },
};

export default function StatusBadge({ status, className }) {
  const s = STATUS[status] || STATUS.stopped;

  return (
    <span
      className={clsx('inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium', className)}
      style={{ color: s.text, background: s.bg, border: `1px solid ${s.border}` }}
    >
      <span
        className={clsx('w-1.5 h-1.5 rounded-full shrink-0', status === 'running' && 'pulse-dot')}
        style={{ backgroundColor: s.dot }}
      />
      {s.label}
    </span>
  );
}
