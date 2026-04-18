import React, { useState, useRef, useEffect } from 'react';
import { Globe } from 'lucide-react';
import { useI18n, LANGUAGES } from '../../i18n';

export default function LanguageSwitcher() {
  const { lang, changeLang, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef(null);
  const searchRef = useRef(null);

  const current = LANGUAGES.find(l => l.code === lang) || LANGUAGES[0];

  const filtered = LANGUAGES.filter(l => {
    const q = search.toLowerCase();
    if (!q) return true;
    const countryCode = [...l.flag].map(c => String.fromCharCode(c.codePointAt(0) - 0x1F1E6 + 65)).join('').toLowerCase();
    return (
      l.native.toLowerCase().includes(q) ||
      l.name.toLowerCase().includes(q) ||
      l.code.toLowerCase().includes(q) ||
      countryCode.includes(q)
    );
  });

  useEffect(() => {
    function onClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false);
        setSearch('');
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  useEffect(() => {
    if (open && searchRef.current) {
      setTimeout(() => searchRef.current?.focus(), 50);
    }
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[#6B6B76] hover:text-[#F0F0F0] hover:bg-[#1C1C21] transition-all duration-200 text-xs font-medium"
        title={t('language.label')}
      >
        <Globe size={14} strokeWidth={1.5} />
        <span className="hidden sm:inline">{current.flag} {current.native}</span>
        <span className="sm:hidden">{current.flag}</span>
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 w-52 rounded-xl overflow-hidden shadow-2xl z-50"
          style={{ background: '#131316', border: '1px solid rgba(255,255,255,0.08)' }}
        >
          {/* Search */}
          <div className="p-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <input
              ref={searchRef}
              type="text"
              className="input text-xs py-1.5"
              placeholder={t('language.search')}
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          {/* Language list */}
          <div className="max-h-60 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="text-center text-[#4A4A55] text-xs py-3">—</p>
            ) : (
              filtered.map(l => (
                <button
                  key={l.code}
                  onClick={() => { changeLang(l.code); setOpen(false); setSearch(''); }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors duration-150 text-left"
                  style={{
                    background: l.code === lang ? 'rgba(255,255,255,0.05)' : 'transparent',
                    color: l.code === lang ? '#F0F0F0' : '#6B6B76',
                  }}
                  onMouseEnter={e => { if (l.code !== lang) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; e.currentTarget.style.color = '#F0F0F0'; }}
                  onMouseLeave={e => { if (l.code !== lang) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#6B6B76'; } }}
                >
                  <span className="text-base leading-none">{l.flag}</span>
                  <span className="flex-1 text-xs font-medium">{l.native}</span>
                  {l.code === lang && (
                    <span className="w-1.5 h-1.5 rounded-full bg-[#4ADE80] shrink-0" />
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
