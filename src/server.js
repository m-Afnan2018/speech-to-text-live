require('dotenv').config();
const http = require('http');
const path = require('path');
const express = require('express');
const { migrate, pool } = require('./db');
const routes = require('./routes');
const { attachLiveProxy } = require('./liveProxy');

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'up', gemini: Boolean(process.env.GEMINI_API_KEY) });
  } catch {
    res.status(503).json({ ok: false, db: 'down' });
  }
});
app.use('/api/transcriptions', routes);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

const server = http.createServer(app);
attachLiveProxy(server);

const PORT = Number(process.env.PORT) || 3000;

(async function start() {
  for (let i = 0; i < 20; i++) {
    try { await migrate(); break; } catch (e) {
      console.log(`waiting for database... (${e.message})`);
      await new Promise((r) => setTimeout(r, 1500));
      if (i === 19) process.exit(1);
    }
  }
  server.listen(PORT, () => console.log(`Speech-to-Text running on http://localhost:${PORT}`));
})();
