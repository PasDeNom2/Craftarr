import toast from 'react-hot-toast';
import { uploadServerIcon, importWorld } from './api';
import { useIconStore } from '../store';

// File d'attente en mémoire des fichiers sélectionnés à la création :
// { [serverId]: { icon?: File, world?: File } }
const pendingQueue = {};

/** Enregistre l'icône et/ou le monde à envoyer une fois l'installation terminée. */
export function queueUploads(serverId, files = {}) {
  if (!serverId) return;
  const { icon, world } = files;
  if (!icon && !world) return;
  pendingQueue[serverId] = {
    ...pendingQueue[serverId],
    ...(icon ? { icon } : {}),
    ...(world ? { world } : {}),
  };
}

/** Vide et retourne les fichiers en attente pour ce serveur (ex. en cas d'échec d'installation). */
export function clearUploads(serverId) {
  const entry = pendingQueue[serverId] || null;
  delete pendingQueue[serverId];
  return entry;
}

/** Envoie séquentiellement l'icône puis le monde en attente pour un serveur installé. */
export async function flushUploads(serverId, t = (key) => key) {
  const entry = pendingQueue[serverId];
  if (!entry || (!entry.icon && !entry.world)) return;
  delete pendingQueue[serverId];

  if (entry.icon) {
    const toastId = toast.loading(t('deploy.uploadingIcon'));
    try {
      await uploadServerIcon(serverId, entry.icon);
      useIconStore.getState().bumpIcon(serverId);
      toast.success(t('deploy.iconUploaded'), { id: toastId });
    } catch (err) {
      toast.error(err.response?.data?.error || t('server.settings.iconError'), { id: toastId });
    }
  }

  if (entry.world) {
    const toastId = toast.loading(t('deploy.uploadingWorld'));
    try {
      await importWorld(serverId, entry.world);
      toast.success(t('worldImport.success'), { id: toastId });
    } catch (err) {
      toast.error(err.response?.data?.error || t('worldImport.error'), { id: toastId });
    }
  }
}
