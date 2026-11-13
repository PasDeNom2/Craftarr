import { useEffect, useState } from 'react';
import { enUS } from 'date-fns/locale/en-US';
import { useI18n } from '../i18n';

const LOCALE_LOADERS = {
  fr: () => import('date-fns/locale/fr'),
  en: () => import('date-fns/locale/en-US'),
  es: () => import('date-fns/locale/es'),
  de: () => import('date-fns/locale/de'),
  pt: () => import('date-fns/locale/pt-BR'),
  it: () => import('date-fns/locale/it'),
  ru: () => import('date-fns/locale/ru'),
  zh: () => import('date-fns/locale/zh-CN'),
  ja: () => import('date-fns/locale/ja'),
  ko: () => import('date-fns/locale/ko'),
  ar: () => import('date-fns/locale/ar'),
  pl: () => import('date-fns/locale/pl'),
  nl: () => import('date-fns/locale/nl'),
  tr: () => import('date-fns/locale/tr'),
  uk: () => import('date-fns/locale/uk'),
  sv: () => import('date-fns/locale/sv'),
  cs: () => import('date-fns/locale/cs'),
};

const cache = { en: enUS };

/** Locale date-fns correspondant à la langue de l'interface. */
export function useDateLocale() {
  const { lang } = useI18n();
  const [locale, setLocale] = useState(() => cache[lang] || enUS);

  useEffect(() => {
    if (cache[lang]) {
      setLocale(cache[lang]);
      return;
    }
    const loader = LOCALE_LOADERS[lang];
    if (!loader) {
      setLocale(enUS);
      return;
    }
    let cancelled = false;
    loader()
      .then((mod) => {
        const resolved = mod.default || enUS;
        cache[lang] = resolved;
        if (!cancelled) setLocale(resolved);
      })
      .catch(() => {
        if (!cancelled) setLocale(enUS);
      });
    return () => {
      cancelled = true;
    };
  }, [lang]);

  return locale;
}
