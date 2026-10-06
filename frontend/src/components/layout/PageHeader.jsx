import React from 'react';
import clsx from 'clsx';

/** En-tête de page commun : titre, description, actions à droite. */
export default function PageHeader({ title, description, actions, className }) {
  return (
    <header className={clsx('flex items-end justify-between gap-4 flex-wrap mb-6', className)}>
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold text-fg tracking-tight leading-tight">{title}</h1>
        {description && <p className="text-[13.5px] text-fg-2 mt-1">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </header>
  );
}

/** Conteneur de page : largeur max + marges cohérentes partout. */
export function Page({ children, wide, className }) {
  return (
    <div className={clsx('px-6 lg:px-10 py-8 mx-auto w-full', wide ? 'max-w-[1400px]' : 'max-w-6xl', className)}>
      {children}
    </div>
  );
}
