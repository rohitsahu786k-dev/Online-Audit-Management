const app = require('../server');

function forward(req, res, route) {
  const queryIndex = req.url ? req.url.indexOf('?') : -1;
  const query = queryIndex >= 0 ? req.url.slice(queryIndex) : '';
  req.url = `${route}${query}`;
  return app(req, res);
}

module.exports = { forward };
