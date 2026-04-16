import React, { useState } from 'react';
import Modal from '../ui/Modal';
import SourceBadge from '../ui/SourceBadge';
import { useQuery } from '@tanstack/react-query';
import { getModpackDetail } from '../../services/api';
import ReactMarkdown from 'react-markdown';
import { Download, Gamepad2, ExternalLink, Rocket } from 'lucide-react';

export default function ModpackDetail({ modpack, onClose, onDeploy }) {
  const { data: detail, isLoading } = useQuery({
    queryKey: ['modpack', modpack?.source, modpack?.id],
    queryFn: () => getModpackDetail(modpack.source, modpack.id),
    enabled: !!modpack,
  });

  const [imgIdx, setImgIdx] = useState(0);
  const screenshots = detail?.screenshots || modpack?.screenshots || [];

  if (!modpack) return null;

  return (
    <Modal open={!!modpack} onClose={onClose} title="Détails du modpack" size="lg">
      <div className="p-6 space-y-6">
        {isLoading ? (
          <div className="text-center py-8 text-[#6B6B76] text-sm">Chargement...</div>
        ) : (
          <>
            {/* Header */}
            <div className="flex gap-4">
              {(detail?.thumbnailUrl || modpack.thumbnailUrl) && (
                <img
                  src={detail?.thumbnailUrl || modpack.thumbnailUrl}
                  alt={detail?.name || modpack.name}
                  className="w-16 h-16 rounded-xl object-cover shrink-0"
                  style={{ background: '#1C1C21' }}
                />
              )}
              <div className="space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-base font-semibold text-[#F0F0F0]">{detail?.name || modpack.name}</h2>
                  <SourceBadge source={modpack.source} sourceName={modpack._sourceName} />
                </div>
                <p className="text-sm text-[#6B6B76]">{detail?.summary || modpack.summary}</p>
                {detail?.authors?.length > 0 && (
                  <p className="text-xs text-[#4A4A55]">Par {detail.authors.join(', ')}</p>
                )}
                <div className="flex gap-3 text-xs text-[#4A4A55] flex-wrap">
                  {(detail?.mcVersions || modpack.mcVersions)?.length > 0 && (
                    <span className="flex items-center gap-1">
                      <Gamepad2 size={11} strokeWidth={1.5} />
                      {(detail?.mcVersions || modpack.mcVersions).slice(0, 3).join(', ')}
                    </span>
                  )}
                  {(detail?.downloadCount || modpack.downloadCount) > 0 && (
                    <span className="flex items-center gap-1">
                      <Download size={11} strokeWidth={1.5} />
                      {((detail?.downloadCount || modpack.downloadCount) / 1000).toFixed(0)}k téléchargements
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Screenshots */}
            {screenshots.length > 0 && (
              <div className="space-y-2">
                <img
                  src={screenshots[imgIdx]}
                  alt="screenshot"
                  className="w-full rounded-xl object-cover max-h-56"
                />
                {screenshots.length > 1 && (
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {screenshots.map((s, i) => (
                      <img
                        key={i}
                        src={s}
                        alt=""
                        onClick={() => setImgIdx(i)}
                        className="w-14 h-14 rounded-lg object-cover cursor-pointer shrink-0 transition-opacity"
                        style={{
                          border: `2px solid ${i === imgIdx ? 'rgba(255,255,255,0.4)' : 'transparent'}`,
                          opacity: i === imgIdx ? 1 : 0.5,
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Description */}
            {detail?.description && (
              <div
                className="text-sm text-[#6B6B76] leading-relaxed prose-invert max-w-none"
                style={{ lineHeight: '1.6' }}
              >
                <ReactMarkdown>{detail.description}</ReactMarkdown>
              </div>
            )}

            {/* Actions */}
            <div
              className="flex gap-3 pt-4"
              style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
            >
              {detail?.websiteUrl && (
                <a
                  href={detail.websiteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-secondary gap-2"
                >
                  <ExternalLink size={13} strokeWidth={1.5} />
                  Site officiel
                </a>
              )}
              <button
                className="btn-primary ml-auto gap-2"
                onClick={() => { onClose(); onDeploy(modpack); }}
              >
                <Rocket size={13} strokeWidth={1.5} />
                Déployer ce modpack
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
