import React, { useState, useRef } from 'react';
import { ImagePlus, X } from 'lucide-react';
import { useI18n } from '../../i18n';

export default function IconPicker({ value, onChange, label }) {
  const { t } = useI18n();
  const [preview, setPreview] = useState(null);
  const inputRef = useRef(null);

  function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    onChange(file);
    const reader = new FileReader();
    reader.onload = ev => setPreview(ev.target.result);
    reader.readAsDataURL(file);
  }

  function handleRemove(e) {
    e.preventDefault();
    onChange(null);
    setPreview(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  return (
    <div className="flex items-center gap-3">
      <input ref={inputRef} type="file" accept="image/*" className="hidden" id="icon-picker-input" onChange={handleFile} />
      <label
        htmlFor="icon-picker-input"
        className="cursor-pointer shrink-0"
        title={label || t('server.settings.icon')}
      >
        <div
          style={{
            width: 52, height: 52, borderRadius: 10,
            background: preview ? 'transparent' : 'rgba(255,255,255,0.05)',
            border: `2px dashed ${preview ? 'rgba(74,222,128,0.4)' : 'rgba(255,255,255,0.12)'}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            overflow: 'hidden',
            transition: 'border-color 0.2s',
          }}
        >
          {preview ? (
            <img src={preview} alt="icon" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <ImagePlus size={18} strokeWidth={1.5} style={{ color: '#4A4A55' }} />
          )}
        </div>
      </label>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-[#6B6B76]">{label || t('server.settings.icon')}</p>
        <p className="text-[11px] text-[#4A4A55] mt-0.5">64×64 px</p>
        {preview && (
          <button type="button" onClick={handleRemove} className="flex items-center gap-1 text-[11px] text-[#F87171] mt-1 hover:opacity-80 transition-opacity">
            <X size={10} strokeWidth={2} /> {t('deploy.worldRemove')}
          </button>
        )}
      </div>
    </div>
  );
}
