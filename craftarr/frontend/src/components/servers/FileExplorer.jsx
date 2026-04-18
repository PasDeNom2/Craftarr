import React, { useState, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { getFiles, getFileContent, putFileContent } from '../../services/api';
import toast from 'react-hot-toast';
import clsx from 'clsx';

const TEXT_EXTENSIONS = new Set([
  'txt', 'log', 'json', 'yaml', 'yml', 'toml', 'properties', 'cfg', 'conf',
  'ini', 'xml', 'sh', 'bat', 'md', 'js', 'ts', 'java', 'py', 'env',
]);

function isEditable(name) {
  const ext = name.split('.').pop()?.toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

function FileIcon({ isDir, name }) {
  if (isDir) return <span className="text-yellow-400">📁</span>;
  const ext = name.split('.').pop()?.toLowerCase();
  if (ext === 'json') return <span className="text-green-400">{ }</span>;
  if (ext === 'log') return <span className="text-gray-400">📄</span>;
  if (['jar', 'zip'].includes(ext)) return <span className="text-blue-400">📦</span>;
  if (['png', 'jpg', 'gif'].includes(ext)) return <span className="text-pink-400">🖼️</span>;
  return <span className="text-gray-400">📄</span>;
}

function formatSize(bytes) {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function FileExplorer({ server }) {
  const [currentPath, setCurrentPath] = useState('');
  const [openFile, setOpenFile] = useState(null); // { path, content }
  const [editContent, setEditContent] = useState('');
  const [dirty, setDirty] = useState(false);

  const { data: dir, isLoading, refetch } = useQuery({
    queryKey: ['files', server.id, currentPath],
    queryFn: () => getFiles(server.id, currentPath),
    retry: false,
  });

  const saveMut = useMutation({
    mutationFn: () => putFileContent(server.id, openFile.path, editContent),
    onSuccess: () => { toast.success('Fichier sauvegardé'); setDirty(false); },
    onError: (err) => toast.error(err.response?.data?.error || 'Erreur lors de la sauvegarde'),
  });

  async function openFileForEdit(entry) {
    if (!isEditable(entry.name)) {
      toast.error('Ce type de fichier ne peut pas être édité dans le navigateur');
      return;
    }
    try {
      const data = await getFileContent(server.id, currentPath ? `${currentPath}/${entry.name}` : entry.name);
      setOpenFile({ path: data.path, name: entry.name });
      setEditContent(data.content);
      setDirty(false);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Impossible de lire le fichier');
    }
  }

  function navigate(name) {
    setCurrentPath(prev => prev ? `${prev}/${name}` : name);
  }

  function navigateUp() {
    setCurrentPath(prev => {
      const parts = prev.split('/');
      parts.pop();
      return parts.join('/');
    });
  }

  const breadcrumbs = ['root', ...currentPath.split('/').filter(Boolean)];

  if (openFile) {
    return (
      <div className="flex flex-col h-full bg-dark-900 rounded-xl border border-dark-500 overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-2 bg-dark-800 border-b border-dark-600">
          <button className="text-xs text-gray-400 hover:text-white" onClick={() => setOpenFile(null)}>
            ← Retour
          </button>
          <span className="text-xs font-mono text-gray-300 truncate">{openFile.path}</span>
          {dirty && <span className="ml-auto text-xs text-yellow-400">● Modifié</span>}
          <button
            className="btn-primary text-xs py-1 px-3 ml-auto"
            onClick={() => saveMut.mutate()}
            disabled={saveMut.isPending || !dirty}
          >
            {saveMut.isPending ? 'Sauvegarde...' : '💾 Sauvegarder'}
          </button>
        </div>
        <textarea
          className="flex-1 bg-dark-950 text-gray-100 font-mono text-xs p-4 resize-none outline-none border-none"
          style={{ backgroundColor: '#0d1117' }}
          value={editContent}
          onChange={e => { setEditContent(e.target.value); setDirty(true); }}
          spellCheck={false}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-dark-900 rounded-xl border border-dark-500 overflow-hidden">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1 px-4 py-2 bg-dark-800 border-b border-dark-600 text-xs font-mono overflow-x-auto">
        {breadcrumbs.map((crumb, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span className="text-gray-600">/</span>}
            <button
              className={clsx('hover:text-white transition-colors', i === breadcrumbs.length - 1 ? 'text-accent' : 'text-gray-400')}
              onClick={() => {
                if (i === 0) setCurrentPath('');
                else setCurrentPath(breadcrumbs.slice(1, i + 1).join('/'));
              }}
            >
              {crumb}
            </button>
          </React.Fragment>
        ))}
        <button className="ml-auto text-gray-500 hover:text-gray-300" onClick={() => refetch()}>↻</button>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="text-gray-500 text-sm text-center py-10">Chargement...</div>
        ) : !dir ? (
          <div className="text-gray-500 text-sm text-center py-10">Dossier inaccessible (serveur non démarré ?)</div>
        ) : dir.entries.length === 0 ? (
          <div className="text-gray-500 text-sm text-center py-10">Dossier vide</div>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {currentPath && (
                <tr className="border-b border-dark-700 hover:bg-dark-800 cursor-pointer" onClick={navigateUp}>
                  <td className="px-4 py-2 w-6"><span className="text-yellow-400">📁</span></td>
                  <td className="px-2 py-2 text-gray-400">..</td>
                  <td className="px-4 py-2 text-gray-600 text-xs text-right"></td>
                </tr>
              )}
              {dir.entries.map(entry => (
                <tr
                  key={entry.name}
                  className="border-b border-dark-700 hover:bg-dark-800 cursor-pointer"
                  onClick={() => entry.isDir ? navigate(entry.name) : openFileForEdit(entry)}
                >
                  <td className="px-4 py-2 w-6"><FileIcon isDir={entry.isDir} name={entry.name} /></td>
                  <td className="px-2 py-2 text-gray-200 font-mono text-xs">{entry.name}</td>
                  <td className="px-4 py-2 text-gray-500 text-xs text-right">{formatSize(entry.size)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
