/** @type {import('tailwindcss').Config} */
// Toutes les couleurs pointent vers les variables CSS de src/index.css :
// changer de thème (data-theme) change réellement toute l'interface.
const rgbVar = (name) => `rgb(var(${name}) / <alpha-value>)`;

module.exports = {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: { DEFAULT: 'var(--bg)', 2: 'var(--bg-2)' },
        surface: { DEFAULT: 'var(--surface)', 2: 'var(--surface-2)', 3: 'var(--surface-3)' },
        fg: { DEFAULT: 'var(--fg)', 2: 'var(--fg-2)', 3: 'var(--fg-3)' },
        line: { DEFAULT: 'var(--line)', strong: 'var(--line-strong)' },
        // Voile neutre qui suit le thème : blanc en sombre, noir en clair (bg-tint/[0.06]…)
        tint: rgbVar('--tint-rgb'),
        // Couleur inverse du texte (texte posé sur un fond --fg)
        inverse: 'var(--inverse)',
        accent: { DEFAULT: 'var(--accent)', hover: 'var(--accent-hover)', ink: 'var(--accent-ink)' },
        success: rgbVar('--success-rgb'),
        danger: rgbVar('--danger-rgb'),
        warn: rgbVar('--warn-rgb'),
        info: rgbVar('--info-rgb'),
        purple: rgbVar('--purple-rgb'),
        orange: rgbVar('--orange-rgb'),
      },
      fontFamily: {
        sans: ['Geist', 'Inter', 'system-ui', 'sans-serif'],
        display: ['Geist', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['"Geist Mono"', '"JetBrains Mono"', 'Consolas', 'monospace'],
      },
      borderRadius: {
        xl: '10px',
        '2xl': '12px',
        '3xl': '16px',
      },
      keyframes: {
        'fade-in-up': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-dot': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.4' },
        },
      },
      animation: {
        'fade-in-up': 'fade-in-up 0.2s ease-out forwards',
        'pulse-dot': 'pulse-dot 2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
