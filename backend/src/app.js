import fs from 'fs';
import path from 'path';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import templateRoutes from './routes/templates.js';
import generatedRoutes from './routes/generatedPdfs.js';
import autoReplyRoutes from './routes/autoReply.js';
import qrLinkRoutes from './routes/qrLink.js';
import attachmentRoutes from './routes/attachments.js';
import trackingRoutes from './routes/tracking.js';
import ticketRoutes from './routes/tickets.js';
import profilingRoutes from './routes/profiling.js';
import clientRoutes from './routes/clients.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const storageRoot = process.env.STORAGE_ROOT || path.resolve(__dirname, '../../storage');

fs.mkdirSync(path.join(storageRoot, 'templates'), { recursive: true });
fs.mkdirSync(path.join(storageRoot, 'generated'), { recursive: true });
fs.mkdirSync(path.join(storageRoot, 'template-predefined-pdfs'), { recursive: true });
fs.mkdirSync(path.join(storageRoot, 'auto-reply-images'), { recursive: true });
fs.mkdirSync(path.join(storageRoot, 'attachments'), { recursive: true });

const app = express();

// Hand-rolled instead of pulling in helmet: the API serves JSON and files, so a
// handful of headers covers it without adding a dependency to install inside a
// running container.
// One nginx container terminates TLS in front of this, so without this the rate
// limiter would see every HTTPS user as the same address and one person's failed
// logins would lock out the whole office.
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  // The portal (:3000 / :443) and the API (:8080) are separate origins, so
  // same-site here blocks the app's own images. Access is controlled by the
  // token the image routes now require, not by this header.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (process.env.FORCE_HSTS === 'true') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

// CORS_ORIGIN takes a comma-separated list; '*' is refused so a stray default
// cannot quietly open the API to every site.
const allowedOrigins = String(process.env.CORS_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value && value !== '*');

app.use(cors({
  origin(origin, callback) {
    // same-origin and non-browser callers send no Origin header
    if (!origin) return callback(null, true);
    return callback(null, allowedOrigins.includes(origin));
  }
}));
app.use(express.json({ limit: '5mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/generated-pdfs', generatedRoutes);
app.use('/api/auto-reply', autoReplyRoutes);
app.use('/api/qr-link', qrLinkRoutes);
app.use('/api', attachmentRoutes);
app.use('/api/tracking', trackingRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/profiling', profilingRoutes);
app.use('/api/clients', clientRoutes);

app.use((err, _req, res, _next) => {
  return res.status(500).json({ error: err.message || 'Internal server error' });
});

export default app;
