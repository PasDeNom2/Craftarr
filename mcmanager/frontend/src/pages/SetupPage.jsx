import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { setupAdmin } from '../services/api';
import { useAuthStore } from '../store';
import { Layers, ShieldCheck } from 'lucide-react';

export default function SetupPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const { setToken, setUser } = useAuthStore();
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    if (!username || !password || !confirm) return;
    if (password !== confirm) {
      toast.error('Les mots de passe ne correspondent pas');
      return;
    }
    if (password.length < 8) {
      toast.error('Mot de passe trop court (min 8 caractères)');
      return;
    }
    setLoading(true);
    try {
      const data = await setupAdmin(username, password);
      setToken(data.token);
      setUser({ username: data.username });
      toast.success('Compte créé — bienvenue !');
      navigate('/', { replace: true });
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur lors de la création du compte');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#09090B] flex items-center justify-center p-4">
      <div className="w-full max-w-sm">

        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 bg-[#F0F0F0] rounded-xl mb-4">
            <Layers size={20} strokeWidth={2} className="text-black" />
          </div>
          <h1 className="text-xl font-semibold text-[#F0F0F0] tracking-tight">MCManager</h1>
          <p className="text-[#6B6B76] text-sm mt-1">Premier démarrage — création du compte</p>
        </div>

        {/* Notice */}
        <div
          className="flex items-start gap-3 rounded-xl px-4 py-3 mb-5 text-sm"
          style={{ background: 'rgba(74,222,128,0.06)', border: '1px solid rgba(74,222,128,0.15)' }}
        >
          <ShieldCheck size={15} strokeWidth={1.5} className="shrink-0 mt-0.5 text-[#4ADE80]" />
          <span className="text-[#6B6B76]">
            Ce compte sera le seul administrateur du panel. Choisissez un mot de passe robuste.
          </span>
        </div>

        {/* Form */}
        <form
          onSubmit={handleSubmit}
          className="space-y-4 p-6 rounded-xl"
          style={{ background: '#131316', border: '1px solid rgba(255,255,255,0.06)' }}
        >
          <div>
            <label className="label">Nom d'utilisateur</label>
            <input
              type="text"
              className="input"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="admin"
              minLength={3}
              autoFocus
              autoComplete="username"
              required
            />
            <p className="text-[11px] text-[#4A4A55] mt-1">Minimum 3 caractères</p>
          </div>

          <div>
            <label className="label">Mot de passe</label>
            <input
              type="password"
              className="input"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              minLength={8}
              autoComplete="new-password"
              required
            />
            <p className="text-[11px] text-[#4A4A55] mt-1">Minimum 8 caractères</p>
          </div>

          <div>
            <label className="label">Confirmer le mot de passe</label>
            <input
              type="password"
              className="input"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              placeholder="••••••••"
              autoComplete="new-password"
              required
            />
            {confirm && password !== confirm && (
              <p className="text-[11px] text-[#F87171] mt-1">Les mots de passe ne correspondent pas</p>
            )}
          </div>

          <button
            type="submit"
            className="btn-primary w-full justify-center py-2.5 mt-2"
            disabled={loading || (confirm.length > 0 && password !== confirm)}
          >
            {loading ? 'Création...' : 'Créer le compte et accéder au panel'}
          </button>
        </form>
      </div>
    </div>
  );
}
