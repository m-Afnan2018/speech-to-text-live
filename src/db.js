const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transcriptions (
      id          SERIAL PRIMARY KEY,
      title       VARCHAR(200) NOT NULL DEFAULT 'Untitled',
      content     TEXT         NOT NULL,
      language    VARCHAR(50)  NOT NULL DEFAULT 'auto',
      duration_ms INTEGER      NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_transcriptions_created ON transcriptions (created_at DESC);
  `);
}

module.exports = { pool, migrate };
