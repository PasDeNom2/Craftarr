// @ts-check
/** @typedef {import('../types').HttpError} HttpError */

/**
 * Middleware Express de gestion centralisée des erreurs.
 * @param {HttpError} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 */
function errorHandler(err, req, res, next) {
  console.error('[ERROR]', err.message || err);
  const status = err.status || err.statusCode || 500;
  const message = status >= 500 && err.expose !== true
    ? 'Erreur interne du serveur'
    : (err.message || 'Erreur interne du serveur');
  res.status(status).json({ error: message });
}

module.exports = errorHandler;
