const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'admin123',
  database: process.env.DB_NAME || 'elysia_db',
});

pool.on('connect', () => {
  console.log(' Conectado exitosamente a PostgreSQL (elysia_db)');
});

pool.on('error', (err) => {
  console.error(' Error en la conexión a PostgreSQL:', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};
