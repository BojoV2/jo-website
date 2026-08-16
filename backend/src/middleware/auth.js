import jwt from 'jsonwebtoken';
import { query } from '../db.js';

// Tokens carry the account's token_version; if the stored version has moved on
// (password change, forced sign-out, off-boarding) the token is dead even though
// its signature is still valid and it has not expired.
const tokenVersions = new Map();
const VERSION_TTL_MS = 30 * 1000;

async function tokenVersionFor(userId) {
  const cached = tokenVersions.get(userId);
  if (cached && Date.now() - cached.at < VERSION_TTL_MS) return cached.value;
  const result = await query('SELECT token_version FROM users WHERE id = $1', [userId]);
  if (result.rowCount === 0) return null;
  const value = result.rows[0].token_version ?? 0;
  tokenVersions.set(userId, { value, at: Date.now() });
  return value;
}

export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded?.id) {
      return tokenVersionFor(decoded.id)
        .then((current) => {
          if (current === null) {
            return res.status(401).json({ error: 'Account no longer exists' });
          }
          if (Number(decoded.tv ?? 0) !== Number(current)) {
            return res.status(401).json({ error: 'Session ended. Please sign in again.' });
          }
          req.user = decoded;
          // Best-effort activity heartbeat; never block request flow if it fails.
          void query('UPDATE users SET last_active_at = NOW() WHERE id = $1', [decoded.id]).catch(() => {});
          return next();
        })
        .catch(() => res.status(401).json({ error: 'Invalid token' }));
    }

    req.user = decoded;
    return next();
  } catch (_err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/* <img src> cannot send an Authorization header, which is why the image routes
   used to be open to anyone who knew the id. They now accept the same session
   token as a query parameter instead of being public. */
export function requireAuthOrQueryToken(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query.t || null);

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    req.user = jwt.verify(String(token), process.env.JWT_SECRET);
    return next();
  } catch (_err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

export function requireRole(...roles) {
  return function roleGuard(req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    return next();
  };
}
