import { useI18n } from '../i18n';
import { fr, enUS, es, de, ptBR, it, ru, zhCN, ja, ko, ar, pl, nl, tr, uk, sv, cs } from 'date-fns/locale';

const LOCALES = { fr, en: enUS, es, de, pt: ptBR, it, ru, zh: zhCN, ja, ko, ar, pl, nl, tr, uk, sv, cs };

/** Locale date-fns correspondant à la langue de l'interface. */
export function useDateLocale() {
  const { lang } = useI18n();
  return LOCALES[lang] || enUS;
}
