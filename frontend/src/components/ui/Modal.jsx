import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { X } from 'lucide-react';
import { useI18n } from '../../i18n';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function Modal({ open, onClose, title, icon: Icon, children, size = 'md', tone = 'default' }) {
  const { t } = useI18n();
  const titleId = useId();
  const dialogRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Capture l'élément actif avant que React n'applique un éventuel autoFocus au montage
  const prevFocusRef = useRef(null);
  const wasOpenRef = useRef(false);
  if (open && !wasOpenRef.current) {
    prevFocusRef.current = document.activeElement;
  }
  wasOpenRef.current = open;

  useEffect(() => {
    if (!open) return;
    const prevFocus = prevFocusRef.current;
    const root = dialogRef.current;

    // Place le focus dans la modale si aucun enfant avec autoFocus n'a déjà pris le focus
    if (root && !root.contains(document.activeElement)) {
      const firstFocusable = root.querySelector(FOCUSABLE_SELECTOR);
      (firstFocusable || root).focus();
    }

    const onKey = (e) => {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.key === 'Tab' && root) {
        const focusables = [...root.querySelectorAll(FOCUSABLE_SELECTOR)].filter(
          (el) => el.tabIndex !== -1 && !el.closest('[inert]'),
        );
        if (focusables.length === 0) {
          e.preventDefault();
          root.focus();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first || !root.contains(document.activeElement)) {
            e.preventDefault();
            last.focus();
          }
        } else if (document.activeElement === last || !root.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', onKey);
    // Empêche la page derrière de défiler
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      if (prevFocus && typeof prevFocus.focus === 'function') {
        prevFocus.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  const sizeClass = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }[size];
  const toneColor = tone === 'danger' ? 'var(--danger)' : 'var(--fg-2)';

  // Portail vers <body> : un parent animé (transform) servait de repère aux éléments fixed
  // → fenêtre décentrée et fond assombri partiel
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="absolute inset-0 fade-in bg-black/60" onClick={onClose} />
      <div ref={dialogRef} tabIndex={-1} className={clsx('glass-strong relative w-full rounded-2xl overflow-hidden pop-in outline-none', sizeClass)}>
        <div className="flex items-center justify-between px-5 h-14 border-b border-line">
          <h2 id={titleId} className="font-semibold text-fg text-[15px] flex items-center gap-2.5 min-w-0">
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
