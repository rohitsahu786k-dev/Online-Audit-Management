const app = require('../server');

module.exports = (req, res) => {
  const rawUrl = req.url || '/';
  const parsed = new URL(rawUrl, 'http://localhost');
  const pathParam = req.query && req.query.path;

  if (pathParam !== undefined) {
    const apiPath = Array.isArray(pathParam) ? pathParam.join('/') : String(pathParam || '');
    parsed.searchParams.delete('path');
    const query = parsed.searchParams.toString();
    req.url = `/api${apiPath ? `/${apiPath.replace(/^\/+/, '')}` : ''}${query ? `?${query}` : ''}`;
  } else if (!rawUrl.startsWith('/api')) {
    const suffix = rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`;
    req.url = `/api${suffix === '/' ? '' : suffix}`;
  }

  return app(req, res);
};
