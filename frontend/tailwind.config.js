/** @type {import('tailwindcss').Config} */
// Toutes les couleurs pointent vers les variables CSS de src/index.css :
// changer de thème (data-theme) change réellement toute l'interface.
module.exports = {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: { DEFAULT: 'var(--bg)', 2: 'var(--bg-2)' },
        surface: { DEFAULT: 'var(--surface)', 2: 'var(--surface-2)', 3: 'var(--surface-3)' },
        fg: { DEFAULT: 'var(--fg)', 2: 'var(--fg-2)', 3: 'var(--fg-3)' },
        line: { DEFAULT: 'var(--line)', strong: 'var(--line-strong)' },
        accent: { DEFAULT: 'var(--accent)', hover: 'var(--accent-hover)', ink: 'var(--accent-ink)' },
        danger: 'var(--danger)',
        warn: 'var(--warn)',
        info: 'var(--info)',
        purple: 'var(--purple)',
        orange: 'var(--orange)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'Fira Code', 'Consolas', 'monospace'],
      },
      borderRadius: {
        '2xl': '16px',
        '3xl': '24px',
      },
      keyframes: {
        'fade-in-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-dot': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.4' },
        },
      },
      animation: {
        'fade-in-up': 'fade-in-up 0.25s cubic-bezier(0.16,1,0.3,1) forwards',
        'pulse-dot': 'pulse-dot 2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
