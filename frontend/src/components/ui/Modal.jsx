import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { X } from 'lucide-react';
import { useI18n } from '../../i18n';

export default function Modal({ open, onClose, title, icon: Icon, children, size = 'md', tone = 'default' }) {
  const { t } = useI18n();
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    // Empêche la page derrière de défiler
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [open, onClose]);

  if (!open) return null;

  const sizeClass = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }[size];
  const toneColor = tone === 'danger' ? 'var(--danger)' : 'var(--fg-2)';

  // Portail vers <body> : un parent animé (transform) servait de repère aux éléments fixed
  // → fenêtre décentrée et fond assombri partiel
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 fade-in bg-black/60" onClick={onClose} />
      <div className={clsx('glass-strong relative w-full rounded-2xl overflow-hidden pop-in', sizeClass)}>
        <div className="flex items-center justify-between px-5 h-14 border-b border-line">
          <h2 className="font-semibold text-fg text-[15px] flex items-center gap-2.5 min-w-0">
            {Icon && <Icon size={16} strokeWidth={1.75} style={{ color: toneColor }} className="shrink-0" />}
            <span className="truncate">{title}</span>
          </h2>
          <button
            onClick={onClose}
            aria-label={t('common.close')}
            className="icon-btn !w-8 !h-8"
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>
        <div className="overflow-y-auto max-h-[80vh]">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
