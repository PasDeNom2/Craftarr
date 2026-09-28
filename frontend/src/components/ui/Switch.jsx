import React from 'react';

/** Interrupteur façon iOS (pastille à ressort) */
export default function Switch({ checked, onChange, label, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative shrink-0 w-[51px] h-[31px] rounded-full transition-colors duration-300 disabled:opacity-50"
      style={{ background: checked ? 'var(--accent)' : 'rgba(120,120,128,0.32)' }}
    >
      <span
        className="absolute top-[2px] left-[2px] w-[27px] h-[27px] rounded-full bg-white"
        style={{
          transform: checked ? 'translateX(20px)' : 'none',
          transition: 'transform .35s cubic-bezier(.3,1.3,.5,1)',
          boxShadow: '0 3px 8px rgba(0,0,0,.3), 0 1px 1px rgba(0,0,0,.16)',
        }}
      />
    </button>
  );
}
