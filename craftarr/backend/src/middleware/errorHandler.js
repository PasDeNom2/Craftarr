function errorHandler(err, req, res, next) {
  console.error('[ERROR]', err.message || err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: err.message || 'Erreur interne du serveur'
  });
}

module.exports = errorHandler;
