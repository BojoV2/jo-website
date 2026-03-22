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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const storageRoot = process.env.STORAGE_ROOT || path.resolve(__dirname, '../../storage');

fs.mkdirSync(path.join(storageRoot, 'templates'), { recursive: true });
fs.mkdirSync(path.join(storageRoot, 'generated'), { recursive: true });
fs.mkdirSync(path.join(storageRoot, 'template-predefined-pdfs'), { recursive: true });
fs.mkdirSync(path.join(storageRoot, 'auto-reply-images'), { recursive: true });
fs.mkdirSync(path.join(storageRoot, 'attachments'), { recursive: true });

const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:3000' }));
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

app.use((err, _req, res, _next) => {
  return res.status(500).json({ error: err.message || 'Internal server error' });
});

export default app;
