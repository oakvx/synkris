const crypto = require('node:crypto');

function isLoopbackHost(host) {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(host).toLowerCase());
}

function adminConfiguration(env = process.env) {
  const host = String(env.ADMIN_HOST || '127.0.0.1').trim();
  const token = String(env.ADMIN_TOKEN || '').trim();
  if ((env.NODE_ENV === 'production' || !isLoopbackHost(host)) && token.length < 32) {
    throw new Error('Set ADMIN_TOKEN to at least 32 random characters before exposing the admin server.');
  }
  if (token && token.length < 32) {
    throw new Error('ADMIN_TOKEN must contain at least 32 random characters.');
  }
  return { host, token };
}

function equalSecret(actual, expected) {
  const digest = (value) => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(digest(actual), digest(expected));
}

function createAdminAuth({ token }) {
  return (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!token) {
      // Local development only. Check the peer and Host to prevent DNS rebinding.
      const peer = req.socket?.remoteAddress || '';
      const localPeer = peer === '::1' || /^127\./.test(peer) || /^::ffff:127\./.test(peer);
      let host;
      try { host = new URL(`http://${req.headers.host}`).hostname; } catch { host = ''; }
      if (localPeer && isLoopbackHost(host)) return next();
      return res.status(403).json({ error: 'Local access only. Configure ADMIN_TOKEN for remote access.' });
    }

    const authorization = String(req.headers.authorization || '');
    let supplied = '';
    const bearer = authorization.match(/^Bearer ([^\s]+)$/i);
    const basic = authorization.match(/^Basic ([A-Za-z0-9+/]+=*)$/i);
    if (bearer) supplied = bearer[1];
    if (basic) {
      const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
      if (decoded.startsWith('admin:')) supplied = decoded.slice(6);
    }
    if (supplied && equalSecret(supplied, token)) return next();
    res.setHeader('WWW-Authenticate', 'Basic realm="WhatsApp AI admin", charset="UTF-8"');
    return res.status(401).json({ error: 'Authentication required.' });
  };
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  next();
}

function httpErrorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  const status = error.status >= 400 && error.status < 500 ? error.status : 500;
  const message = status === 413 ? 'Request body too large.'
    : status === 400 ? 'Invalid request body.' : status < 500 ? 'Request rejected.' : 'Internal server error.';
  return res.status(status).json({ error: message });
}

function twilioConfiguration(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const host = String(env.IVR_HOST || '127.0.0.1').trim();
  const authToken = String(env.TWILIO_AUTH_TOKEN || '').trim();
  const rawBase = String(env.PUBLIC_BASE_URL || '').trim();
  let publicBaseUrl = null;
  if (rawBase) {
    let parsed;
    try { parsed = new URL(rawBase); } catch { throw new Error('PUBLIC_BASE_URL must be an absolute HTTP(S) URL.'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('PUBLIC_BASE_URL must be an HTTP(S) base URL without credentials, query or fragment.');
    }
    if (production && parsed.protocol !== 'https:') throw new Error('PUBLIC_BASE_URL must use HTTPS in production.');
    publicBaseUrl = rawBase.replace(/\/+$/, '');
  }
  if ((production || !isLoopbackHost(host) || publicBaseUrl) && (!authToken || !publicBaseUrl)) {
    throw new Error('Public IVR requires TWILIO_AUTH_TOKEN and PUBLIC_BASE_URL (HTTPS in production).');
  }
  if (authToken && !publicBaseUrl) {
    throw new Error('Set PUBLIC_BASE_URL to validate Twilio webhook signatures against the public URL.');
  }
  return { authToken, publicBaseUrl, host };
}

function createTwilioAuth({ authToken, publicBaseUrl }, validateRequest) {
  return (req, res, next) => {
    if (req.method !== 'POST') return res.sendStatus(405);
    if (!req.is('application/x-www-form-urlencoded')) return res.sendStatus(415);
    if (authToken) {
      const signature = req.headers['x-twilio-signature'];
      // originalUrl preserves the query string. Never derive the signed host from request headers.
      const url = `${publicBaseUrl}${req.originalUrl}`;
      let valid = false;
      try {
        valid = typeof signature === 'string' && validateRequest(authToken, signature, url, req.body || {});
      } catch { /* Reject malformed signatures without exposing SDK errors. */ }
      if (!valid) return res.status(403).json({ error: 'Invalid Twilio signature.' });
    }
    if (!/^CA[0-9a-f]{32}$/i.test(String(req.body?.CallSid || ''))) {
      return res.status(400).json({ error: 'Invalid CallSid.' });
    }
    next();
  };
}

module.exports = {
  adminConfiguration, createAdminAuth, createTwilioAuth, httpErrorHandler,
  isLoopbackHost, securityHeaders, twilioConfiguration,
};
