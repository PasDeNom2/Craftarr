import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { login } from '../services/api';
import { useAuthStore } from '../store';
import { Layers } from 'lucide-react';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const { setToken, setUser } = useAuthStore();
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    if (!username || !password) return;
    setLoading(true);
    try {
      const data = await login(username, password);
      setToken(data.token);
      setUser({ username: data.username });
      navigate('/', { replace: true });
    } catch (err) {
      toast.error(err.response?.data?.error || 'Identifiants invalides');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#09090B] flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 bg-[#F0F0F0] rounded-xl mb-4">
            <Layers size={20} strokeWidth={2} className="text-black" />
          </div>
          <h1 className="text-xl font-semibold text-[#F0F0F0] tracking-tight">MCManager</h1>
          <p className="text-[#6B6B76] text-sm mt-1">Gestionnaire de serveurs Minecraft</p>
        </div>

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
              autoFocus
            />
          </div>
          <div>
            <label className="label">Mot de passe</label>
            <input
              type="password"
              className="input"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>
          <button
            type="submit"
            className="btn-primary w-full justify-center py-2.5 mt-2"
            disabled={loading}
          >
            {loading ? 'Connexion...' : 'Se connecter'}
          </button>
        </form>
      </div>
    </div>
  );
}
