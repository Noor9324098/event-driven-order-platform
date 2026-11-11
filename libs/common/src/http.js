import express from 'express';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createApp(name) {
  const app = express();
  app.use(express.json());
  app.get('/health', (_req, res) => res.json({ service: name, status: 'ok' }));
  return app;
}

/** Call last, after all routes are registered. */
export function finalize(app, log) {
  app.use((_req, res) => res.status(404).json({ error: 'not found' }));
  app.use((err, _req, res, _next) => {
    const status = err.status ?? (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) log?.error('request failed', { error: err.message });
    res.status(status).json({ error: status >= 500 ? 'internal error' : err.message });
  });
}
