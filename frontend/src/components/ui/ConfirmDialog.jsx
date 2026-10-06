import React, { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import Modal from './Modal';
import { useI18n } from '../../i18n';

/**
 * Confirmation d'une action destructive. Avec `requireText`, il faut retaper ce texte
 * (ex. le nom du serveur) : impossible de supprimer un serveur par un clic malheureux.
 */
export default function ConfirmDialog({
  open, onClose, onConfirm, title, message, confirmLabel, requireText, busy = false, tone = 'danger',
}) {
  const { t } = useI18n();
  const [typed, setTyped] = useState('');
  const matches = !requireText || typed.trim() === requireText;

  function close() { setTyped(''); onClose(); }
  function submit(e) {
    e.preventDefault();
    if (!matches || busy) return;
    onConfirm();
  }

  return (
    <Modal open={open} onClose={close} title={title} icon={AlertTriangle} size="sm" tone={tone}>
      <form onSubmit={submit} className="p-5 space-y-4">
        <p className="text-sm text-fg-2 leading-relaxed">{message}</p>
        {requireText && (
          <div>
            <label className="label">{t('confirm.typeToConfirm', { name: requireText })}</label>
            <input
              className="input font-mono"
              value={typed}
              onChange={e => setTyped(e.target.value)}
              placeholder={requireText}
              autoFocus
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        )}
        <div className="flex gap-2 pt-1">
          <button type="button" className="btn-ghost" onClick={close}>{t('common.cancel')}</button>
          <button
            type="submit"
            className="btn ml-auto font-semibold"
            disabled={!matches || busy}
            style={tone === 'danger'
              ? { background: 'var(--danger)', color: '#fff' }
              : { background: 'var(--fg)', color: 'var(--inverse)' }}
          >
            {busy ? '…' : (confirmLabel || t('common.confirm'))}
          </button>
        </div>
      </form>
    </Modal>
  );
}
