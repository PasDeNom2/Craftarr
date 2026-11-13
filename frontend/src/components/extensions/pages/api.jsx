import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  KeyRound,
  Plus,
  Search,
  Shield,
  Trash2,
} from 'lucide-react';
import toast from 'react-hot-toast';
import PageHeader, { Page } from '../../layout/PageHeader';
import Modal from '../../ui/Modal';
import ConfirmDialog from '../../ui/ConfirmDialog';
import Switch from '../../ui/Switch';
import Segmented from '../../ui/Segmented';
import { useI18n } from '../../../i18n';
import { useAuthStore } from '../../../store';
import { parseDbDate } from '../../../utils/dates';
import {
  createApiKey,
  getApiKeys,
  getOpenApiSpec,
  revokeApiKey,
} from '../../../services/features/api-keys';

export const page = {
  path: 'api',
  navKey: 'apiKeys.nav',
  Icon: KeyRound,
  order: 30,
};

const MAX_ACTIVE_KEYS = 25;
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

const METHOD_BADGE_CLASSES = {
  get: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  post: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
  put: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  patch: 'bg-violet-500/15 text-violet-400 border-violet-500/30',
  delete: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
};

function formatDate(raw, lang) {
  if (!raw) return null;
  const date = parseDbDate(raw);
  if (!date) return String(raw);
  try {
    return new Intl.DateTimeFormat(lang || 'fr', {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

function deriveKeyStatus(item) {
  if (item.revoked) return 'revoked';
  if (item.expires_at) {
    const exp = parseDbDate(item.expires_at);
    if (exp && exp.getTime() <= Date.now()) return 'expired';
  }
  return 'active';
}

function getAuthKind(security) {
  if (!Array.isArray(security) || security.length === 0) return 'public';
  const hasApiKey = security.some((entry) => entry && Object.prototype.hasOwnProperty.call(entry, 'apiKeyAuth'));
  return hasApiKey ? 'any' : 'session';
}

function buildSampleValue(schema, depth = 0) {
  if (!schema || depth > 2) return '...';
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.default !== undefined) return schema.default;
  if (schema.type === 'boolean') return true;
  if (schema.type === 'integer' || schema.type === 'number') return 1;
  if (schema.type === 'array') return [buildSampleValue(schema.items, depth + 1)];
  if (schema.type === 'object' || schema.properties) {
    const obj = {};
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(props).slice(0, 6)) {
      obj[k] = buildSampleValue(v, depth + 1);
    }
    return obj;
  }
  return 'value';
}

function buildCurlSnippet(op, origin) {
  const base = origin || 'http://localhost:3001';
  let resolvedPath = op.path;
  const queryPairs = [];

  for (const param of op.parameters || []) {
    if (param.in === 'path') {
      const sample = param.schema?.example || `<${param.name}>`;
      resolvedPath = resolvedPath.replace(`{${param.name}}`, String(sample));
    } else if (param.in === 'query' && param.required) {
      const val = param.schema?.example || param.schema?.default || `<${param.name}>`;
      queryPairs.push(`${encodeURIComponent(param.name)}=${encodeURIComponent(String(val))}`);
    }
  }

  const qs = queryPairs.length > 0 ? `?${queryPairs.join('&')}` : '';
  const url = `${base}${resolvedPath}${qs}`;
  const parts = ['curl'];
  const upperMethod = op.method.toUpperCase();
  if (upperMethod !== 'GET') parts.push(`-X ${upperMethod}`);

  const authKind = getAuthKind(op.security);
  if (authKind === 'any') {
    parts.push('-H "X-API-Key: cra_YOUR_API_KEY"');
  } else if (authKind === 'session') {
    parts.push('-H "Authorization: Bearer YOUR_JWT_TOKEN"');
  }

  const jsonMedia = op.requestBody?.content?.['application/json'];
  if (jsonMedia) {
    const samplePayload = jsonMedia.example !== undefined
      ? jsonMedia.example
      : buildSampleValue(jsonMedia.schema);
    parts.push('-H "Content-Type: application/json"');
    parts.push(`-d '${JSON.stringify(samplePayload)}'`);
  } else if (op.requestBody?.content?.['multipart/form-data']) {
    parts.push('-F "file=@/path/to/file"');
  }

  parts.push(`"${url}"`);
  return parts.join(' \\\n  ');
}

async function copyToClipboard(text, t, onCopied) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(t('apiKeys.copiedToast'));
    if (onCopied) onCopied();
  } catch {
    toast.error(t('apiKeys.copyError'));
  }
}

function ApiKeysPanel() {
  const { t, lang } = useI18n();
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'admin';

  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAll, setShowAll] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [name, setName] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [expiryPreset, setExpiryPreset] = useState('never');
  const [customDays, setCustomDays] = useState('30');

  const [revealedKey, setRevealedKey] = useState(null);
  const [copiedSecret, setCopiedSecret] = useState(false);

  const [revokeTarget, setRevokeTarget] = useState(null);
  const [revoking, setRevoking] = useState(false);

  const loadKeys = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await getApiKeys({ all: isAdmin && showAll });
      setKeys(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err?.response?.data?.error || t('apiKeys.loadError'));
    } finally {
      setLoading(false);
    }
  }, [isAdmin, showAll, t]);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  const ownActiveCount = useMemo(() => {
    return keys.filter((k) => {
      if (user?.id && k.user_id !== user.id) return false;
      return deriveKeyStatus(k) === 'active';
    }).length;
  }, [keys, user?.id]);

  function openCreateModal() {
    setName('');
    setReadOnly(false);
    setExpiryPreset('never');
    setCustomDays('30');
    setCreateError('');
    setCreateOpen(true);
  }

  async function handleCreateSubmit(e) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setCreateError(t('apiKeys.createModal.nameRequired'));
      return;
    }

    const payload = { name: trimmed, read_only: readOnly };
    if (expiryPreset === 'custom') {
      const parsed = Number.parseInt(customDays, 10);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3650) {
        setCreateError(t('apiKeys.createModal.expiryDaysLabel'));
        return;
      }
      payload.expires_in_days = parsed;
    } else if (expiryPreset !== 'never') {
      payload.expires_in_days = Number.parseInt(expiryPreset, 10);
    }

    setCreating(true);
    setCreateError('');
    try {
      const created = await createApiKey(payload);
      setCreateOpen(false);
      setCopiedSecret(false);
      setRevealedKey(created);
      toast.success(t('apiKeys.createdToast'));
      await loadKeys();
    } catch (err) {
      setCreateError(err?.response?.data?.error || 'Error');
    } finally {
      setCreating(false);
    }
  }

  async function handleConfirmRevoke() {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      await revokeApiKey(revokeTarget.id);
      toast.success(t('apiKeys.revokedToast'));
      setRevokeTarget(null);
      await loadKeys();
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Error');
    } finally {
      setRevoking(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="card p-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <Shield className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="text-sm text-zinc-200">{t('apiKeys.securityHint')}</p>
            <p className="text-xs text-zinc-400">
              {t('apiKeys.activeQuota', { count: ownActiveCount, max: MAX_ACTIVE_KEYS })}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 shrink-0">
          {isAdmin && (
            <Switch
              checked={showAll}
              onChange={setShowAll}
              label={t('apiKeys.showAllToggle')}
            />
          )}
          <button
            type="button"
            className="btn-primary flex items-center gap-2"
            onClick={openCreateModal}
          >
            <Plus className="w-4 h-4" />
            <span>{t('apiKeys.createBtn')}</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="card p-4 border-rose-500/40 bg-rose-500/10 text-sm text-rose-300">
          {error}
        </div>
      )}

      <div className="card overflow-hidden">
        {loading ? (
          <div className="p-6 text-sm text-zinc-400">...</div>
        ) : keys.length === 0 ? (
          <div className="p-8 text-center text-sm text-zinc-400">{t('apiKeys.empty')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-zinc-800/80 text-xs uppercase text-zinc-400">
                <tr>
                  <th className="px-4 py-3 font-medium">{t('apiKeys.columns.name')}</th>
                  <th className="px-4 py-3 font-medium">{t('apiKeys.columns.prefix')}</th>
                  {isAdmin && showAll && (
                    <th className="px-4 py-3 font-medium">{t('apiKeys.columns.owner')}</th>
                  )}
                  <th className="px-4 py-3 font-medium">{t('apiKeys.columns.mode')}</th>
                  <th className="px-4 py-3 font-medium">{t('apiKeys.columns.status')}</th>
                  <th className="px-4 py-3 font-medium">{t('apiKeys.columns.lastUsed')}</th>
                  <th className="px-4 py-3 font-medium">{t('apiKeys.columns.expires')}</th>
                  <th className="px-4 py-3 font-medium text-right">{t('apiKeys.columns.actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {keys.map((item) => {
                  const status = deriveKeyStatus(item);
                  const lastUsed = formatDate(item.last_used_at, lang);
                  const expires = formatDate(item.expires_at, lang);
                  return (
                    <tr key={item.id} className="hover:bg-zinc-900/40">
                      <td className="px-4 py-3 font-medium text-zinc-100">{item.name}</td>
                      <td className="px-4 py-3 font-mono text-xs text-zinc-300">
                        cra_{item.prefix}…
                      </td>
                      {isAdmin && showAll && (
                        <td className="px-4 py-3 text-zinc-300">{item.username || '—'}</td>
                      )}
                      <td className="px-4 py-3">
                        <span
                          className={`badge ${
                            item.read_only
                              ? 'bg-sky-500/15 text-sky-300 border-sky-500/30'
                              : 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                          }`}
                        >
                          {item.read_only ? t('apiKeys.mode.readOnly') : t('apiKeys.mode.readWrite')}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`badge ${
                            status === 'active'
                              ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                              : status === 'expired'
                                ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                                : 'bg-zinc-700/40 text-zinc-400 border-zinc-600/40'
                          }`}
                        >
                          {t(`apiKeys.status.${status}`)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-zinc-300 whitespace-nowrap">
                        {lastUsed || t('apiKeys.neverUsed')}
                      </td>
                      <td className="px-4 py-3 text-zinc-300 whitespace-nowrap">
                        {expires || t('apiKeys.neverExpires')}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          disabled={item.revoked}
                          onClick={() => setRevokeTarget(item)}
                          className="btn-danger px-2.5 py-1 text-xs inline-flex items-center gap-1.5 disabled:opacity-40 disabled:pointer-events-none"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>{t('apiKeys.revokeBtn')}</span>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal
        open={createOpen}
        onClose={() => !creating && setCreateOpen(false)}
        title={t('apiKeys.createModal.title')}
        icon={KeyRound}
        size="md"
      >
        <form onSubmit={handleCreateSubmit} className="space-y-4">
          {createError && (
            <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-sm text-rose-300">
              {createError}
            </div>
          )}

          <div>
            <label htmlFor="api-key-name" className="label">
              {t('apiKeys.createModal.nameLabel')}
            </label>
            <input
              id="api-key-name"
              type="text"
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('apiKeys.createModal.namePlaceholder')}
              className="input w-full"
              autoFocus
            />
          </div>

          <div className="p-3 rounded-lg bg-zinc-900/60 border border-zinc-800 space-y-1.5">
            <Switch
              checked={readOnly}
              onChange={setReadOnly}
              label={t('apiKeys.createModal.readOnlyLabel')}
            />
            <p className="text-xs text-zinc-400">{t('apiKeys.createModal.readOnlyHelp')}</p>
          </div>

          <div>
            <label htmlFor="api-key-expiry" className="label">
              {t('apiKeys.createModal.expiryLabel')}
            </label>
            <select
              id="api-key-expiry"
              value={expiryPreset}
              onChange={(e) => setExpiryPreset(e.target.value)}
              className="input w-full"
            >
              <option value="never">{t('apiKeys.createModal.expiryNever')}</option>
              <option value="7">{t('apiKeys.createModal.expiry7')}</option>
              <option value="30">{t('apiKeys.createModal.expiry30')}</option>
              <option value="90">{t('apiKeys.createModal.expiry90')}</option>
              <option value="365">{t('apiKeys.createModal.expiry365')}</option>
              <option value="custom">{t('apiKeys.createModal.expiryCustom')}</option>
            </select>
          </div>

          {expiryPreset === 'custom' && (
            <div>
              <label htmlFor="api-key-expiry-days" className="label">
                {t('apiKeys.createModal.expiryDaysLabel')}
              </label>
              <input
                id="api-key-expiry-days"
                type="number"
                min={1}
                max={3650}
                value={customDays}
                onChange={(e) => setCustomDays(e.target.value)}
                className="input w-full"
              />
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              className="btn-secondary"
              disabled={creating}
              onClick={() => setCreateOpen(false)}
            >
              {t('apiKeys.createModal.cancel')}
            </button>
            <button type="submit" className="btn-primary" disabled={creating}>
              {t('apiKeys.createModal.submit')}
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        open={Boolean(revealedKey)}
        onClose={() => setRevealedKey(null)}
        title={t('apiKeys.revealModal.title')}
        icon={KeyRound}
        size="md"
      >
        {revealedKey && (
          <div className="space-y-4">
            <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-start gap-2.5 text-sm text-amber-200">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <span>{t('apiKeys.revealModal.warning')}</span>
            </div>

            <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800 flex items-center justify-between gap-2">
              <code className="font-mono text-xs sm:text-sm text-emerald-300 break-all select-all">
                {revealedKey.key}
              </code>
              <button
                type="button"
                className="btn-secondary shrink-0 inline-flex items-center gap-1.5 text-xs"
                onClick={() => copyToClipboard(revealedKey.key, t, () => setCopiedSecret(true))}
              >
                {copiedSecret ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedSecret ? t('apiKeys.copiedBtn') : t('apiKeys.copyBtn')}</span>
              </button>
            </div>

            <p className="text-xs text-zinc-400 font-mono">{t('apiKeys.revealModal.usageHint')}</p>

            <div className="flex justify-end pt-1">
              <button
                type="button"
                className="btn-primary"
                onClick={() => setRevealedKey(null)}
              >
                {t('apiKeys.revealModal.close')}
              </button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(revokeTarget)}
        onClose={() => !revoking && setRevokeTarget(null)}
        onConfirm={handleConfirmRevoke}
        title={t('apiKeys.revokeTitle')}
        message={t('apiKeys.revokeMessage', { name: revokeTarget?.name || '' })}
        confirmLabel={t('apiKeys.revokeBtn')}
        busy={revoking}
        tone="danger"
      />
    </div>
  );
}

function OpenApiDocsPanel() {
  const { t } = useI18n();
  const [spec, setSpec] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [selectedTag, setSelectedTag] = useState('all');
  const [expanded, setExpanded] = useState({});
  const [copiedId, setCopiedId] = useState('');

  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3001';

  const loadSpec = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await getOpenApiSpec();
      setSpec(data);
    } catch {
      setError(t('apiKeys.docs.loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadSpec();
  }, [loadSpec]);

  const { groups, totalCount } = useMemo(() => {
    if (!spec?.paths) return { groups: [], totalCount: 0 };

    const q = query.trim().toLowerCase();
    const tagDescriptions = new Map();
    const tagOrder = [];
    for (const tagObj of spec.tags || []) {
      tagDescriptions.set(tagObj.name, tagObj.description || '');
      tagOrder.push(tagObj.name);
    }

    const byTag = new Map();
    let count = 0;

    for (const [pathStr, pathItem] of Object.entries(spec.paths)) {
      const sharedParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
      for (const method of HTTP_METHODS) {
        const op = pathItem[method];
        if (!op) continue;
        const tags = Array.isArray(op.tags) && op.tags.length > 0 ? op.tags : ['Other'];
        if (selectedTag !== 'all' && !tags.includes(selectedTag)) continue;

        const haystack = [
          method,
          pathStr,
          op.summary || '',
          op.description || '',
          ...tags,
        ].join(' ').toLowerCase();
        if (q && !haystack.includes(q)) continue;

        count += 1;
        const mergedParams = [...sharedParams, ...(Array.isArray(op.parameters) ? op.parameters : [])];
        const entry = {
          id: `${method}:${pathStr}`,
          method,
          path: pathStr,
          summary: op.summary || '',
          description: op.description || '',
          security: op.security,
          parameters: mergedParams,
          requestBody: op.requestBody || null,
          responses: op.responses || {},
        };

        const primaryTag = selectedTag !== 'all' ? selectedTag : tags[0];
        if (!byTag.has(primaryTag)) byTag.set(primaryTag, []);
        byTag.get(primaryTag).push(entry);
      }
    }

    const orderedTags = [
      ...tagOrder.filter((name) => byTag.has(name)),
      ...[...byTag.keys()].filter((name) => !tagOrder.includes(name)),
    ];

    return {
      groups: orderedTags.map((name) => ({
        name,
        description: tagDescriptions.get(name) || '',
        operations: byTag.get(name),
      })),
      totalCount: count,
    };
  }, [spec, query, selectedTag]);

  const availableTags = useMemo(() => {
    if (!spec?.tags) return [];
    return spec.tags.map((tg) => tg.name);
  }, [spec]);

  function toggleExpand(id) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  if (loading) {
    return <div className="card p-6 text-sm text-zinc-400">{t('apiKeys.docs.loading')}</div>;
  }

  if (error || !spec) {
    return (
      <div className="card p-6 flex items-center justify-between gap-4 border-rose-500/40 bg-rose-500/10">
        <span className="text-sm text-rose-300">{error || t('apiKeys.docs.loadError')}</span>
        <button type="button" className="btn-secondary" onClick={loadSpec}>
          {t('apiKeys.docs.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="card p-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-1 flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              id="openapi-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('apiKeys.docs.searchPlaceholder')}
              aria-label={t('apiKeys.docs.searchPlaceholder')}
              className="input w-full pl-9"
            />
          </div>

          <select
            id="openapi-tag-filter"
            value={selectedTag}
            onChange={(e) => setSelectedTag(e.target.value)}
            aria-label={t('apiKeys.docs.tagAll')}
            className="input sm:w-56"
          >
            <option value="all">{t('apiKeys.docs.tagAll')}</option>
            {availableTags.map((tag) => (
              <option key={tag} value={tag}>{tag}</option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <span className="text-xs text-zinc-400">
            {t('apiKeys.docs.endpointsCount', { count: totalCount })}
          </span>
          <a
            href="/api/openapi.json"
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary inline-flex items-center gap-1.5 text-xs"
          >
            <span>{t('apiKeys.docs.specLink')}</span>
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="card p-8 text-center text-sm text-zinc-400">{t('apiKeys.docs.noResults')}</div>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <section key={group.name} className="card overflow-hidden">
              <div className="px-4 py-3 border-b border-zinc-800/80 bg-zinc-900/40 flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-zinc-100">{group.name}</h3>
                  {group.description && (
                    <p className="text-xs text-zinc-400 mt-0.5">{group.description}</p>
                  )}
                </div>
                <span className="text-xs text-zinc-500">
                  {t('apiKeys.docs.endpointsCount', { count: group.operations.length })}
                </span>
              </div>

              <div className="divide-y divide-zinc-800/60">
                {group.operations.map((op) => {
                  const isOpen = Boolean(expanded[op.id]);
                  const authKind = getAuthKind(op.security);
                  const authLabel = authKind === 'public'
                    ? t('apiKeys.docs.authPublic')
                    : authKind === 'session'
                      ? t('apiKeys.docs.authSession')
                      : t('apiKeys.docs.authAny');
                  const curlCmd = isOpen ? buildCurlSnippet(op, origin) : '';
                  const jsonReq = op.requestBody?.content?.['application/json'];

                  return (
                    <div key={op.id}>
                      <button
                        type="button"
                        onClick={() => toggleExpand(op.id)}
                        aria-expanded={isOpen}
                        className="w-full px-4 py-3 text-left flex flex-wrap items-center gap-3 hover:bg-zinc-900/40 transition-colors"
                      >
                        {isOpen
                          ? <ChevronDown className="w-4 h-4 text-zinc-400 shrink-0" />
                          : <ChevronRight className="w-4 h-4 text-zinc-400 shrink-0" />}

                        <span
                          className={`badge font-mono uppercase text-[11px] w-16 justify-center shrink-0 ${
                            METHOD_BADGE_CLASSES[op.method] || 'bg-zinc-700/40 text-zinc-200 border-zinc-600'
                          }`}
                        >
                          {op.method}
                        </span>

                        <code className="font-mono text-xs sm:text-sm text-zinc-100 break-all">
                          {op.path}
                        </code>

                        <span className="text-xs sm:text-sm text-zinc-400 flex-1 min-w-[180px]">
                          {op.summary}
                        </span>

                        <span
                          className={`badge text-[11px] shrink-0 ${
                            authKind === 'public'
                              ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25'
                              : authKind === 'session'
                                ? 'bg-amber-500/10 text-amber-300 border-amber-500/25'
                                : 'bg-zinc-800 text-zinc-300 border-zinc-700'
                          }`}
                        >
                          {authLabel}
                        </span>
                      </button>

                      {isOpen && (
                        <div className="px-4 pb-4 pt-2 bg-zinc-950/50 border-t border-zinc-800/50 space-y-4 text-xs">
                          {op.description && (
                            <p className="text-zinc-300">{op.description}</p>
                          )}

                          {op.parameters.length > 0 && (
                            <div className="space-y-1.5">
                              <h4 className="font-semibold text-zinc-300 uppercase tracking-wider text-[11px]">
                                {t('apiKeys.docs.parameters')}
                              </h4>
                              <div className="rounded-lg border border-zinc-800 divide-y divide-zinc-800/70">
                                {op.parameters.map((p) => (
                                  <div key={`${p.in}-${p.name}`} className="px-3 py-2 flex flex-wrap items-center gap-2">
                                    <code className="font-mono text-zinc-100">{p.name}</code>
                                    <span className="badge bg-zinc-800 text-zinc-300 border-zinc-700">
                                      {p.in === 'path' ? t('apiKeys.docs.paramInPath') : t('apiKeys.docs.paramInQuery')}
                                    </span>
                                    {p.required && (
                                      <span className="badge bg-rose-500/15 text-rose-300 border-rose-500/30">
                                        {t('apiKeys.docs.paramRequired')}
                                      </span>
                                    )}
                                    {p.schema?.type && (
                                      <span className="font-mono text-zinc-400">
                                        {Array.isArray(p.schema.type) ? p.schema.type.join(' | ') : p.schema.type}
                                        {Array.isArray(p.schema.enum) ? ` (${p.schema.enum.join(', ')})` : ''}
                                      </span>
                                    )}
                                    {p.description && <span className="text-zinc-400">{p.description}</span>}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {op.requestBody && (
                            <div className="space-y-1.5">
                              <h4 className="font-semibold text-zinc-300 uppercase tracking-wider text-[11px]">
                                {t('apiKeys.docs.requestBody')}
                              </h4>
                              {jsonReq ? (
                                <pre className="p-3 rounded-lg bg-zinc-950 border border-zinc-800 font-mono text-zinc-200 overflow-x-auto">
                                  {JSON.stringify(
                                    jsonReq.example !== undefined
                                      ? jsonReq.example
                                      : buildSampleValue(jsonReq.schema),
                                    null,
                                    2,
                                  )}
                                </pre>
                              ) : (
                                <div className="p-2.5 rounded-lg bg-zinc-950 border border-zinc-800 font-mono text-zinc-300">
                                  {Object.keys(op.requestBody.content || {}).join(', ')}
                                </div>
                              )}
                            </div>
                          )}

                          <div className="space-y-1.5">
                            <h4 className="font-semibold text-zinc-300 uppercase tracking-wider text-[11px]">
                              {t('apiKeys.docs.responses')}
                            </h4>
                            <div className="rounded-lg border border-zinc-800 divide-y divide-zinc-800/70">
                              {Object.entries(op.responses).map(([code, resp]) => {
                                const codeNum = Number(code);
                                const respClass = codeNum >= 200 && codeNum < 300
                                  ? 'text-emerald-300'
                                  : codeNum >= 400
                                    ? 'text-rose-300'
                                    : 'text-zinc-300';
                                return (
                                  <div key={code} className="px-3 py-2 space-y-1.5">
                                    <div className="flex items-center gap-3">
                                      <span className={`font-mono font-semibold ${respClass}`}>{code}</span>
                                      <span className="text-zinc-300">{resp.description}</span>
                                    </div>
                                    {resp.content?.['application/json']?.example !== undefined && (
                                      <pre className="p-2 rounded bg-zinc-950 border border-zinc-800/80 font-mono text-zinc-300 overflow-x-auto">
                                        {JSON.stringify(resp.content['application/json'].example, null, 2)}
                                      </pre>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>

                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between">
                              <h4 className="font-semibold text-zinc-300 uppercase tracking-wider text-[11px]">
                                {t('apiKeys.docs.curlExample')}
                              </h4>
                              <button
                                type="button"
                                className="btn-secondary px-2 py-1 text-[11px] inline-flex items-center gap-1"
                                onClick={() => copyToClipboard(curlCmd, t, () => setCopiedId(op.id))}
                              >
                                {copiedId === op.id
                                  ? <Check className="w-3 h-3 text-emerald-400" />
                                  : <Copy className="w-3 h-3" />}
                                <span>{copiedId === op.id ? t('apiKeys.copiedBtn') : t('apiKeys.docs.copyCurl')}</span>
                              </button>
                            </div>
                            <pre className="p-3 rounded-lg bg-zinc-950 border border-zinc-800 font-mono text-emerald-300/90 overflow-x-auto">
                              {curlCmd}
                            </pre>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ApiPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState('keys');

  const tabs = useMemo(() => [
    { id: 'keys', label: t('apiKeys.tabs.keys'), icon: KeyRound },
    { id: 'docs', label: t('apiKeys.tabs.docs'), icon: BookOpen },
  ], [t]);

  return (
    <Page>
      <PageHeader
        title={t('apiKeys.title')}
        description={t('apiKeys.subtitle')}
        actions={<Segmented items={tabs} value={tab} onChange={setTab} />}
      />

      {tab === 'keys' ? <ApiKeysPanel /> : <OpenApiDocsPanel />}
    </Page>
  );
}
