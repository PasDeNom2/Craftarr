import React from 'react';
import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { useI18n } from '../i18n';
import { LogoMark } from '../components/ui/Logo';

export default function NotFoundPage() {
  const { t } = useI18n();
  return (
    <div className="h-full flex items-center justify-center p-8">
      <div className="text-center max-w-sm pop-in">
        <div className="relative inline-block mb-6">
          <LogoMark size={48} className="opacity-40" />
        </div>
        <p className="eyebrow mb-2">404</p>
        <h1 className="text-xl font-semibold text-fg tracking-tight">{t('notFound.title')}</h1>
        <p className="text-sm text-fg-2 mt-2">{t('notFound.body')}</p>
        <Link to="/catalog" className="btn-primary mt-6">
          <Compass size={14} strokeWidth={2} /> {t('notFound.back')}
        </Link>
      </div>
    </div>
  );
}
