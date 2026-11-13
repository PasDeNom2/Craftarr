/* global localStorage, matchMedia, document */
// Thème appliqué avant le premier rendu (pas de flash clair/sombre).
// Fichier séparé et non inline : la CSP n'autorise que les scripts de la même origine.
try {
  var t = localStorage.getItem('craftarr_theme') || 'dark';
  if (t === 'system') t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t === 'light' ? 'light' : 'dark');
  if (localStorage.getItem('craftarr_cb') === '1') document.documentElement.setAttribute('data-cb', '1');
} catch {
  // Stockage indisponible (navigation privée stricte) : thème sombre par défaut
}
