const app = require('../server');

module.exports = (req, res) => {
  if (req.url && !req.url.startsWith('/api')) {
    const suffix = req.url.startsWith('/') ? req.url : `/${req.url}`;
    req.url = `/api${suffix === '/' ? '' : suffix}`;
  }

  return app(req, res);
};
