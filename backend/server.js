require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const net = require('net');

const { getPool } = require('./db/connection');
const { errorHandler, notFound } = require('./middleware/errorHandler');

// Route imports
const authRoutes      = require('./routes/auth');
const reportRoutes    = require('./routes/reports');
const disasterRoutes  = require('./routes/disasters');
const teamRoutes      = require('./routes/teams');
const resourceRoutes  = require('./routes/resources');
const financeRoutes   = require('./routes/finance');
const hospitalRoutes  = require('./routes/hospitals');
const analyticsRoutes = require('./routes/analytics');
const userRoutes     = require('./routes/users');

const app = express();
const PREFERRED_PORT = parseInt(process.env.PORT, 10) || 5000;

// ─── Port Helper ──────────────────────────────────────────────────────────────
function getAvailablePort(preferred) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        // Preferred port is busy; let the OS pick any available port
        const fallback = net.createServer();
        fallback.listen(0, () => {
          const port = fallback.address().port;
          fallback.close(() => resolve(port));
        });
      } else {
        reject(err);
      }
    });
    server.once('listening', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.listen(preferred);
  });
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || process.env.NODE_ENV !== 'production') {
      callback(null, true);
      return;
    }
    const allowed = [process.env.FRONTEND_URL];
    if (allowed.includes(origin)) callback(null, true);
    else callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === 'development' ? 'dev' : 'combined'));

// Serve frontend static files
app.use(express.static(path.join(__dirname, '../frontend')));

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/auth',       authRoutes);
app.use('/api/reports',    reportRoutes);
app.use('/api/disasters',  disasterRoutes);
app.use('/api/teams',      teamRoutes);
app.use('/api/resources',  resourceRoutes);
app.use('/api/finance',    financeRoutes);
app.use('/api/hospitals',  hospitalRoutes);
app.use('/api/analytics',  analyticsRoutes);
app.use('/api/users',      userRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString(), service: 'Disaster MIS API' });
});

// Database health check (Azure SQL connectivity probe)
app.get('/api/health/db', async (req, res, next) => {
  try {
    const { getPool } = require('./db/connection');
    const pool = await getPool();
    const result = await pool.request().query('SELECT @@VERSION AS version, DB_NAME() AS [database]');
    res.json({
      status: 'OK',
      timestamp: new Date().toISOString(),
      database: result.recordset[0].database,
      version: result.recordset[0].version,
    });
  } catch (err) {
    next(err);
  }
});

// Catch-all → redirect to frontend login page (preserves correct base URL for relative links)
app.get('*', (req, res) => {
  res.redirect('/pages/login.html');
});

// ─── Error Handling ───────────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ─── Start Server ─────────────────────────────────────────────────────────────
const start = async () => {
  try {
    await getPool();
    const PORT = await getAvailablePort(PREFERRED_PORT);
    const server = app.listen(PORT, () => {
      const actualPort = server.address().port;
      console.log(`\n🚀 Disaster MIS Server running on port ${actualPort}`);
      console.log(`   API:      http://localhost:${actualPort}/api`);
      console.log(`   Frontend: http://localhost:${actualPort}`);
      console.log(`   Database: ${process.env.DB_DATABASE} @ ${process.env.DB_SERVER}\n`);
    });
  } catch (err) {
    console.error('❌ Failed to start server:', err);
    process.exit(1);
  }
};

start();

