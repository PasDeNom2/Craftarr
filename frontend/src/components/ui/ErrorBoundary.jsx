import React, { useState } from 'react';
import clsx from 'clsx';
import { RotateCcw, RefreshCw, ClipboardCopy, Check, ChevronDown } from 'lucide-react';
import { useI18n } from '../../i18n';

// Visage de creeper 8×8 (1 = pixel foncé)
const CREEPER = [
  '00000000',
  '00000000',
  '01100110',
  '01100110',
  '00011000',
  '00111100',
  '00111100',
  '00100100',
];
// Nuances de vert pour la « peau » (déterministe, façon texture)
const SKIN = ['var(--accent)', 'rgba(var(--accent-rgb),0.78)', 'rgba(var(--accent-rgb),0.62)'];

function CreeperFace({ size = 88, shaking }) {
  const px = size / 8;
  return (
    <svg
      width={size} height={size} viewBox={`0 0 ${size} ${size}`}
      className={clsx(shaking && 'creeper-shake')}
      style={{ imageRendering: 'pixelated' }}
      aria-hidden="true"
    >
      {CREEPER.flatMap((row, y) => [...row].map((c, x) => (
        <rect
          key={`${x}-${y}`} x={x * px} y={y * px} width={px + 0.5} height={px + 0.5}
          fill={c === '1' ? '#0B1A10' : SKIN[(x * 7 + y * 3) % 3]}
        />
      )))}
    </svg>
  );
}

function buildReport(error, info) {
  return [
    `Craftarr — rapport d'erreur`,
    `Date : ${new Date().toISOString()}`,
    `Page : ${window.location.href}`,
    `Navigateur : ${navigator.userAgent}`,
    '',
    `Erreur : ${error?.message || error}`,
    '',
    error?.stack || '',
    '',
    'Composants :',
    info?.componentStack || '',
  ].join('\n');
}

function CrashScreen({ error, info, onRetry, scope }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const full = scope === 'app';

  async function copyReport() {
    try {
      await navigator.clipboard.writeText(buildReport(error, info));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* presse-papiers indisponible (http) : les détails restent affichables */ setShowDetails(true); }
  }

  return (
    <div className={clsx('flex items-center justify-center p-8', full ? 'min-h-screen atmosphere' : 'min-h-[360px] h-full')}>
      <div className="max-w-md w-full text-center pop-in">
        <div className="flex justify-center mb-6"><CreeperFace size={full ? 104 : 80} shaking /></div>
        <p className="eyebrow mb-2">{t('crash.eyebrow')}</p>
        <h2 className="text-xl font-semibold text-fg tracking-tight">{t('crash.title')}</h2>
        <p className="text-sm text-fg-2 mt-2 leading-relaxed">{full ? t('crash.bodyApp') : t('crash.bodyPanel')}</p>

        <div className="flex flex-wrap justify-center gap-2 mt-6">
          <button className="btn-primary" onClick={onRetry}>
            <RotateCcw size={14} strokeWidth={2} /> {t('crash.retry')}
          </button>
          <button className="btn-secondary" onClick={() => window.location.reload()}>
            <RefreshCw size={14} strokeWidth={1.75} /> {t('crash.reload')}
          </button>
          <button className="btn-ghost" onClick={copyReport}>
            {copied ? <Check size={14} className="text-accent" /> : <ClipboardCopy size={14} strokeWidth={1.75} />}
            {copied ? t('crash.copied') : t('crash.copy')}
          </button>
        </div>

        <button
          className="mt-5 inline-flex items-center gap-1 text-xs text-fg-3 hover:text-fg-2 transition-colors"
          onClick={() => setShowDetails(d => !d)}
        >
          {t('crash.details')}
          <ChevronDown size={12} style={{ transform: showDetails ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }} />
        </button>
        {showDetails && (
          <pre className="mt-3 text-left text-[11px] leading-relaxed font-mono text-danger bg-bg-2 border border-line rounded-xl p-3 max-h-48 overflow-auto whitespace-pre-wrap fade-in">
            {error?.message || String(error)}
            {'\n\n'}
            <span className="text-fg-3">{(error?.stack || '').split('\n').slice(1, 6).join('\n')}</span>
          </pre>
        )}
      </div>
    </div>
  );
}

/**
 * Attrape les erreurs de rendu d'une zone de l'interface.
 * scope="app"   : écran plein (dernier filet de sécurité)
 * scope="panel" : seule la zone plante, la navigation reste utilisable.
 * resetKey      : quand il change (ex. onglet, page), l'erreur est oubliée.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
    this.retry = () => this.setState({ error: null, info: null });
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    this.setState({ info });
    console.error('[Craftarr] Erreur d\'interface attrapée :', error, info?.componentStack);
  }

  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) this.retry();
  }

  render() {
    if (this.state.error) {
      return <CrashScreen error={this.state.error} info={this.state.info} onRetry={this.retry} scope={this.props.scope || 'panel'} />;
    }
    return this.props.children;
  }
}
