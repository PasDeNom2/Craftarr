import React from 'react';
import LanguageSwitcher from '../ui/LanguageSwitcher';
import { LogoMark } from '../ui/Logo';
import { useI18n } from '../../i18n';

/** Mise en page des écrans hors application (connexion, premier démarrage). */
export default function AuthShell({ subtitle, children }) {
  const { t } = useI18n();
  return (
    <div className="min-h-screen atmosphere relative flex items-center justify-center p-6 overflow-hidden">
      {/* halo d'accent derrière la carte */}
      <div
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[720px] h-[720px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle, rgba(var(--accent-rgb),0.10), transparent 60%)' }}
      />
      <div className="fixed top-4 right-4 z-10"><LanguageSwitcher /></div>

      <div className="relative w-full max-w-[380px]">
        <div className="text-center mb-8 card-in">
          <div className="inline-block animate-[float_6s_ease-in-out_infinite]">
            <LogoMark size={64} glow />
          </div>
          <h1 className="font-pixel text-[26px] text-fg mt-5 tracking-wide">
            CRAFT<span className="text-accent">ARR</span>
          </h1>
          <p className="text-fg-2 text-sm mt-2">{subtitle || t('app.tagline')}</p>
        </div>
        <div className="card-in" style={{ animationDelay: '80ms' }}>{children}</div>
      </div>
    </div>
  );
}
