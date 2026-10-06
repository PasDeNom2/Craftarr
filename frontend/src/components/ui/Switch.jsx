import React from 'react';

/** Interrupteur compact : piste pleine (couleur du texte) quand activé. */
export default function Switch({ checked, onChange, label, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative shrink-0 w-9 h-5 rounded-full border transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
      style={{
        background: checked ? 'var(--fg)' : 'var(--surface-2)',
        borderColor: checked ? 'var(--fg)' : 'var(--line-strong)',
      }}
    >
      <span
        className="absolute top-[2px] left-[2px] w-3.5 h-3.5 rounded-full transition-transform duration-150"
        style={{
          background: checked ? 'var(--inverse)' : 'var(--fg-3)',
          transform: checked ? 'translateX(16px)' : 'none',
        }}
      />
    </button>
  );
}
