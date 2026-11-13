/**
 * Points d'extension de l'interface : chaque fonctionnalité ajoute ses propres fichiers,
 * sans modifier les pages existantes (moins de conflits entre fonctionnalités).
 *
 * components/extensions/tabs/*.jsx
 *   export const tab = { id, Icon, labelKey, order, show?(server) => bool, fullHeight? }
 *   export default function Tab({ server })            → onglet de la page serveur
 * components/extensions/settings/*.jsx
 *   export const section = { id, titleKey, descKey?, order }
 *   export default function Section()                  → section de la page Paramètres
 * components/extensions/server-settings/*.jsx
 *   export const block = { id, order, show?(server) => bool }
 *   export default function Block({ server })          → bloc ajouté à l'onglet Paramètres d'un serveur
 *                                                         (enregistre lui-même via PATCH /servers/:id)
 * components/extensions/pages/*.jsx
 *   export const page = { path, navKey?, Icon?, order }
 *   export default function Page()                     → route ajoutée (et lien dans la barre latérale si navKey)
 *
 * Ordre des onglets du cœur : console 10, mods 20, métriques 30, sauvegardes 40, fichiers 50,
 * joueurs 60, liste blanche 70, paramètres 90.
 */
const byOrder = (a, b) => (a.order ?? 100) - (b.order ?? 100);

function collect(modules, key) {
  return Object.entries(modules)
    .filter(([, m]) => m && m[key] && m.default)
    .map(([file, m]) => ({ ...m[key], Component: m.default, file }))
    .sort(byOrder);
}

export const extraTabs = collect(import.meta.glob('../components/extensions/tabs/*.jsx', { eager: true }), 'tab');
export const extraSettingsSections = collect(import.meta.glob('../components/extensions/settings/*.jsx', { eager: true }), 'section');
export const extraServerSettings = collect(import.meta.glob('../components/extensions/server-settings/*.jsx', { eager: true }), 'block');
export const extraPages = collect(import.meta.glob('../components/extensions/pages/*.jsx', { eager: true }), 'page');
