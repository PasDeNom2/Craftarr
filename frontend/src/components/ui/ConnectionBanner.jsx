import React, { useEffect, useRef, useState } from 'react';
import { WifiOff } from 'lucide-react';
import toast from 'react-hot-toast';
import { getSocket } from '../../hooks/useSocket';
import { useI18n } from '../../i18n';

/**
 * Bandeau affiché quand la connexion temps réel au backend est perdue (redémarrage de
 * Craftarr, coupure réseau…). Évite de croire qu'un serveur est figé alors que c'est
 * l'interface qui ne reçoit plus rien. Délai de 3 s pour ignorer les micro-coupures.
 */
export default function ConnectionBanner() {
  const { t } = useI18n();
  const [lost, setLost] = useState(false);
  const shown = useRef(false);
  const timer = useRef(null);

  useEffect(() => {
    const socket = getSocket();
    const onDown = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => { shown.current = true; setLost(true); }, 3000);
    };
    const onUp = () => {
      clearTimeout(timer.current);
      if (shown.current) toast.success(t('connection.restored'));
      shown.current = false;
      setLost(false);
    };
    socket.on('disconnect', onDown);
    socket.on('connect_error', onDown);
    socket.on('connect', onUp);
    if (!socket.connected) onDown();
    return () => {
      clearTimeout(timer.current);
      socket.off('disconnect', onDown);
      socket.off('connect_error', onDown);
      socket.off('connect', onUp);
    };
  }, [t]);

  if (!lost) return null;
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2.5 px-4 py-2 text-xs font-medium fade-in"
      style={{ background: 'rgba(var(--warn-rgb),0.1)', borderBottom: '1px solid rgba(var(--warn-rgb),0.25)', color: 'var(--warn)' }}
    >
      <WifiOff size={13} strokeWidth={2} />
      {t('connection.lost')}
      <span className="inline-flex gap-0.5" aria-hidden="true">
        {[0, 1, 2].map(i => (
          <span key={i} className="status-block live" style={{ width: 4, height: 4, animationDelay: `${i * 0.25}s` }} />
        ))}
      </span>
    </div>
  );
}
