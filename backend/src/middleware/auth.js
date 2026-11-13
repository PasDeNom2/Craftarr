const { verifyUserToken, verifyApiKey } = require('../config/secrets');

function isSessionOnlyPath(req) {
  const full = `${req.baseUrl || ''}${req.path || ''}`.replace(/^\/api(?=\/|$)/i, '');
  const segs = full.split('/').filter(Boolean).map(s => s.toLowerCase());
  if (segs[0] === 'api-keys') return true;
  if (segs[0] === 'auth' && (segs[1] === 'password' || segs[1] === '2fa')) return true;
  return false;
}

function authMiddleware(req, res, next) {
  const rawApiKey = req.headers['x-api-key'];
  const xApiKey = typeof rawApiKey === 'string' ? rawApiKey.trim() : '';
  const authHeader = req.headers.authorization;
  const bearer = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (!xApiKey && !bearer) {
    return res.status(401).json({ error: 'Token manquant' });
  }

  try {
    if (xApiKey || bearer.startsWith('cra_')) {
      const { user, apiKey } = verifyApiKey(xApiKey || bearer);
      req.user = user;
      req.apiKey = apiKey;

      if (isSessionOnlyPath(req)) {
        return res.status(403).json({ error: 'Cette route exige une session utilisateur' });
      }
      const method = req.method.toUpperCase();
      if (apiKey.read_only && method !== 'GET' && method !== 'HEAD') {
        return res.status(403).json({ error: 'Clé API en lecture seule' });
      }
      return next();
    }

    req.user = verifyUserToken(bearer);
    next();
  } catch (err) {
    const disabled = err?.message === 'compte désactivé';
    return res.status(401).json({ error: disabled ? 'Compte désactivé' : 'Token invalide ou expiré' });
  }
}

module.exports = authMiddleware;
