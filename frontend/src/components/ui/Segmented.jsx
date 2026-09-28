import React, { useLayoutEffect, useRef, useState } from 'react';
import clsx from 'clsx';

/**
 * Contrôle segmenté façon iOS : la pastille glisse d'un segment à l'autre (courbe ressort).
 * items : [{ id, label, icon?, badge? }]
 */
export default function Segmented({ items, value, onChange, className, size = 'md' }) {
  const wrapRef = useRef(null);
  const [thumb, setThumb] = useState(null);

  useLayoutEffect(() => {
    const measure = () => {
      const el = wrapRef.current?.querySelector(`[data-seg="${CSS.escape(String(value))}"]`);
      if (el) setThumb({ left: el.offsetLeft, width: el.offsetWidth });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [value, items.length]);

  return (
    <div ref={wrapRef} role="tablist" className={clsx('segmented relative', size === 'sm' && 'segmented-sm', thumb && 'has-thumb', className)}>
      {thumb && (
        <span
          aria-hidden
          className="segmented-thumb"
          style={{ transform: `translateX(${thumb.left}px)`, width: thumb.width }}
        />
      )}
      {items.map(({ id, label, icon: Icon, badge }) => (
        <button
          key={id}
          type="button"
          role="tab"
          data-seg={id}
          aria-selected={value === id}
          onClick={() => onChange(id)}
          className="segmented-item"
        >
          {Icon && <Icon size={size === 'sm' ? 12 : 14} strokeWidth={1.75} />}
          {label}
          {badge}
        </button>
      ))}
    </div>
  );
}
