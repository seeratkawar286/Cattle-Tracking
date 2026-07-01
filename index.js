/**
 * sylCloud HCS048 Cattle Ear Tag — Cloud Data Processing Server
 * ─────────────────────────────────────────────────────────────
 * • TCP Socket Server  : ingests raw HCS048 device packets     (TCP_PORT, default 8080)
 * • REST API           : exposes parsed data to web/mobile     (PORT,     default 3000)
 * • WebSocket Server   : real-time push to dashboards          (PORT /ws)
 *
 * Production hardening applied:
 *   ✓ NODE_ENV-aware logging
 *   ✓ CORS origin whitelist from env
 *   ✓ JSON body size capped at 50kb
 *   ✓ Compression middleware
 *   ✓ Rate limit configurable from env
 *   ✓ MongoDB reconnect options + event logging
 *   ✓ TCP max connections + buffer overflow guard
 *   ✓ SIGTERM + SIGINT graceful shutdown (both TCP and HTTP)
 *   ✓ uncaughtException + unhandledRejection handlers
 *   ✓ JWT_SECRET startup validation
 *   ✓ 404 handler + global Express error handler
 *   ✓ mongoose.set('strictQuery', true)
 */

'use strict';
require('dotenv').config();

// ── Startup environment validation ────────────────────────────────────────
const REQUIRED_ENV = ['MONGO_URI', 'JWT_SECRET'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`[FATAL] Missing required environment variables: ${missing.join(', ')}`);
  console.error('[FATAL] Copy .env.example to .env and fill all values.');
  process.exit(1);
}

if (process.env.JWT_SECRET === 'CHANGE_THIS_TO_A_64_BYTE_RANDOM_HEX_STRING' ||
    process.env.JWT_SECRET.length < 32) {
  console.error('[FATAL] JWT_SECRET is too short or is still the placeholder. Generate a secure secret.');
  process.exit(1);
}

const express     = require('express');
const http        = require('http');
const WebSocket   = require('ws');
const mongoose    = require('mongoose');
const cors        = require('cors');
const helmet      = require('helmet');
const morgan      = require('morgan');
const rateLimit   = require('express-rate-limit');
const compression = require('compression');

const { createTcpServer, setWsBroadcast } = require('./tcp/socketServer');
const sleepDetector  = require('./services/sleepDetector');
const cattleRoutes   = require('./routes/cattle');
const alarmRoutes    = require('./routes/alarms');
const authRoutes     = require('./routes/auth');
const analyticsA     = require('./routes/analytics/analyticsA');
const analyticsB     = require('./routes/analytics/analyticsB');
const analyticsC     = require('./routes/analytics/analyticsC');
const analyticsConfig = require('./routes/analytics/analyticsConfig');

// ── Config ─────────────────────────────────────────────────────────────────
const PORT      = parseInt(process.env.PORT      || '3000', 10);
const TCP_PORT  = parseInt(process.env.TCP_PORT  || '8080', 10);
const MONGO     = process.env.MONGO_URI;
const IS_PROD   = process.env.NODE_ENV === 'production';
const RATE_MAX  = parseInt(process.env.RATE_LIMIT_MAX || '100', 10);

// CORS origins: comma-separated list in env, or allow all in dev
const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
  : false;   // false = allow all (development only)

// ── Mongoose config ────────────────────────────────────────────────────────
mongoose.set('strictQuery', true);

// ── Express App ────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// Security
app.use(helmet());
app.use(cors({
  origin: corsOrigins || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Performance
app.use(compression());

// Logging — combined (Apache-style) in production, dev in development
app.use(morgan(process.env.LOG_FORMAT || (IS_PROD ? 'combined' : 'dev')));

// Body parsing — 50 kb cap prevents payload bloat attacks
app.use(express.json({ limit: '50kb' }));

// Rate limiting
app.use(rateLimit({
  windowMs:        60_000,
  max:             RATE_MAX,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { success: false, error: 'Too many requests — please slow down' },
}));

// Trust proxy (required when behind nginx / load balancer)
if (IS_PROD) app.set('trust proxy', 1);

// ── Routes ─────────────────────────────────────────────────────────────────
app.use('/api/v1',          authRoutes);
app.use('/api/v1/cattle',   cattleRoutes);
app.use('/api/v1',          alarmRoutes);       // /api/v1/alarms + /api/v1/geofences

// Analytics APIs 1–30
app.use('/api/v1/analytics', analyticsA);       // APIs  1–10
app.use('/api/v1/analytics', analyticsB);       // APIs 11–20
app.use('/api/v1/analytics', analyticsC);       // APIs 21–30
app.use('/api/v1',           analyticsConfig);  // config + dashboard

// Health check (no auth — used by load balancer)
app.get('/health', (_, res) => res.json({
  status:  'ok',
  service: 'sylCloud HCS048 Server',
version: require('./package.json').version,
  uptime:  Math.floor(process.uptime()),
  time:    new Date().toISOString(),
}));

// API index
app.get('/api/v1', (_, res) => res.json({
  service: 'sylCloud Cattle Ear Tag API v1',
  docs:    'See /api/v1/analytics/dashboard/:animalId for full API map',
  endpoints: {
    auth:        { 'POST /api/v1/auth/login': 'Obtain JWT token' },
    cattle:      {
      'GET  /api/v1/cattle':                   'All tags — live dashboard',
      'GET  /api/v1/cattle/:imei':             'Single tag — full state',
      'GET  /api/v1/cattle/:imei/behaviour':   'Behaviour state + history',
      'GET  /api/v1/cattle/:imei/location':    'GPS location + GeoJSON',
      'GET  /api/v1/cattle/:imei/history':     'GPS breadcrumb trail',
      'GET  /api/v1/cattle/:imei/battery':     'Battery level + trend',
      'GET  /api/v1/cattle/:imei/status':      'Tag metadata snapshot',
      'GET  /api/v1/cattle/:imei/alarms':      'Alarm history',
      'GET  /api/v1/cattle/:imei/geofence':    'Geofence assignment',
      'PATCH /api/v1/cattle/:imei/geofence':   'Assign geofence',
      'GET  /api/v1/cattle/filter/moving':     'All moving animals',
      'GET  /api/v1/cattle/filter/grazing':    'All grazing animals',
      'GET  /api/v1/cattle/filter/ruminating': 'All ruminating animals',
      'GET  /api/v1/cattle/filter/sleeping':   'All sleeping animals',
    },
    alarms: {
      'GET  /api/v1/alarms':                    'All alarm events',
      'GET  /api/v1/alarms/active':             'Unacknowledged alarms',
      'GET  /api/v1/alarms/summary':            'Count by type',
      'POST /api/v1/alarms/:id/acknowledge':    'Acknowledge alarm',
      'POST /api/v1/alarms/acknowledge-bulk':   'Bulk acknowledge',
    },
    geofences: {
      'GET    /api/v1/geofences':       'List all geofences',
      'POST   /api/v1/geofences':       'Create geofence (GeoJSON Polygon)',
      'GET    /api/v1/geofences/:id':   'Get single geofence',
      'PUT    /api/v1/geofences/:id':   'Update geofence',
      'DELETE /api/v1/geofences/:id':   'Delete + unassign',
      'POST   /api/v1/geofences/check': 'Point-in-polygon test',
    },
    analytics: {
      'GET /api/v1/analytics/activity-score/:id':     'API 1  — Activity score',
      'GET /api/v1/analytics/movement-pattern/:id':   'API 2  — Movement pattern %',
      'GET /api/v1/analytics/daily-distance/:id':     'API 3  — Daily distance (Haversine)',
      'GET /api/v1/analytics/speed-analysis/:id':     'API 4  — Speed analysis',
      'GET /api/v1/analytics/grazing-time/:id':       'API 5  — Grazing hours',
      'GET /api/v1/analytics/grazing-zones/:id':      'API 6  — Zone heatmap (50m grid)',
      'GET /api/v1/analytics/pasture-rotation/:id':   'API 7  — Rotation compliance',
      'GET /api/v1/analytics/inactivity/:id':         'API 8  — Inactivity alert',
      'GET /api/v1/analytics/abnormal-activity/:id':  'API 9  — Abnormal activity',
      'GET /api/v1/analytics/health-risk/:id':        'API 10 — Health risk score',
      'GET /api/v1/analytics/lameness/:id':           'API 11 — Lameness detection',
      'GET /api/v1/analytics/heat-detection/:id':     'API 12 — Heat detection',
      'GET /api/v1/analytics/breeding-window/:id':    'API 13 — Breeding window',
      'GET /api/v1/analytics/fertility/:id':          'API 14 — Fertility behaviour',
      'GET /api/v1/analytics/herd-cohesion':          'API 15 — Herd cohesion',
      'GET /api/v1/analytics/isolation/:id':          'API 16 — Isolation detection',
      'GET /api/v1/analytics/leader-follower':        'API 17 — Leader-follower',
      'GET /api/v1/analytics/social-score/:id':       'API 18 — Social score',
      'GET /api/v1/analytics/geofence-violations/:id':'API 19 — Geofence violations',
      'GET /api/v1/analytics/escape-risk/:id':        'API 20 — Escape risk',
      'GET /api/v1/analytics/water-visits/:id':       'API 21 — Water point visits',
      'GET /api/v1/analytics/feed-visits/:id':        'API 22 — Feed zone visits',
      'GET /api/v1/analytics/theft-detection':        'API 23 — Theft detection',
      'GET /api/v1/analytics/missing-animals':        'API 24 — Missing animals',
      'GET /api/v1/analytics/recovery/:id':           'API 25 — Animal recovery',
      'GET /api/v1/analytics/behaviour-anomaly/:id':  'API 26 — Behaviour anomaly',
      'GET /api/v1/analytics/welfare-score/:id':      'API 27 — Welfare score',
      'GET /api/v1/analytics/productivity-score/:id': 'API 28 — Productivity score',
      'GET /api/v1/analytics/disease-risk/:id':       'API 29 — Disease risk',
      'GET /api/v1/analytics/insurance-risk/:id':     'API 30 — Insurance risk',
      'GET /api/v1/analytics/dashboard/:id':          'Full daily summary (all metrics)',
      'GET /api/v1/analytics/herd-summary':           'All animals — one-row overview',
    },
    config: {
      'GET  /api/v1/config/water-points':        'List water sources',
      'POST /api/v1/config/water-points':        'Add water source',
      'GET  /api/v1/config/feed-zones':          'List feed zones',
      'POST /api/v1/config/feed-zones':          'Add feed zone',
      'GET  /api/v1/config/pasture-rotation':    'List rotation schedules',
      'POST /api/v1/config/pasture-rotation':    'Create rotation schedule',
    },
    realtime: {
      'WS /ws':  'WebSocket — events: LOCATION_UPDATE, ALARM',
    },
  },
}));

// ── 404 handler ────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, error: `Route not found: ${req.method} ${req.path}` });
});

// ── Global Express error handler ──────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.stack || err.message);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    success: false,
    error:   IS_PROD ? 'Internal server error' : err.message,
  });
});

// ── WebSocket Server ───────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`[WS] Client connected: ${ip}`);
  ws.send(JSON.stringify({ event: 'CONNECTED', message: 'sylCloud real-time stream active' }));
  ws.on('close', () => console.log(`[WS] Client disconnected: ${ip}`));
  ws.on('error', e => console.error('[WS] Error:', e.message));
});

setWsBroadcast(msg => {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
});

// ── Uncaught error handlers ────────────────────────────────────────────────
process.on('uncaughtException', err => {
  console.error('[FATAL] Uncaught exception:', err.stack || err.message);
  gracefulShutdown('uncaughtException').then(() => process.exit(1));
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled promise rejection:', reason);
  gracefulShutdown('unhandledRejection').then(() => process.exit(1));
});

// ── Graceful shutdown ──────────────────────────────────────────────────────
let _tcpServer = null;
let _isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (_isShuttingDown) return;
  _isShuttingDown = true;
  console.log(`[Server] ${signal} received — shutting down gracefully`);

  sleepDetector.stop();

  // Stop accepting new HTTP connections
  server.close(() => console.log('[HTTP] Server closed'));

  // Close TCP ingestion server
  if (_tcpServer) _tcpServer.close(() => console.log('[TCP] Server closed'));

  // Disconnect MongoDB
  try {
    await mongoose.disconnect();
    console.log('[DB] MongoDB disconnected');
  } catch (e) {
    console.error('[DB] Disconnect error:', e.message);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM').then(() => process.exit(0)));
process.on('SIGINT',  () => gracefulShutdown('SIGINT').then(() => process.exit(0)));

// ── MongoDB connection + server start ─────────────────────────────────────
const MONGO_OPTS = {
  maxPoolSize:              parseInt(process.env.MONGO_POOL_SIZE || '10', 10),
  serverSelectionTimeoutMS: 10000,
  heartbeatFrequencyMS:     30000,
  socketTimeoutMS:          45000,
};

mongoose.connection.on('disconnected', () => console.warn('[DB] MongoDB disconnected — attempting reconnect'));
mongoose.connection.on('reconnected',  () => console.log('[DB] MongoDB reconnected'));
mongoose.connection.on('error', err  => console.error('[DB] MongoDB error:', err.message));

mongoose.connect(MONGO, MONGO_OPTS)
  .then(() => {
    console.log('[DB] MongoDB connected:', MONGO.replace(/:\/\/.*@/, '://***@'));

    server.listen(PORT, () => {
      console.log(`[HTTP] REST API  → http://localhost:${PORT}/api/v1`);
      console.log(`[WS]  WebSocket  → ws://localhost:${PORT}/ws`);
    });

    _tcpServer = createTcpServer(TCP_PORT);

    sleepDetector.start();

    console.log(`[OK] sylCloud HCS048 Server v${require('../package.json').version} running`);
    console.log(`[OK] Environment: ${process.env.NODE_ENV || 'development'}`);
  })
  .catch(err => {
    console.error('[FATAL] MongoDB connection failed:', err.message);
    process.exit(1);
  });
