'use strict';
/**
 * Configuration & Dashboard Routes
 *
 * POST /api/v1/config/water-points     — Add water source coordinate
 * GET  /api/v1/config/water-points     — List water sources
 * POST /api/v1/config/feed-zones       — Add feed zone
 * GET  /api/v1/config/feed-zones       — List feed zones
 * POST /api/v1/config/pasture-rotation — Create rotation schedule
 * GET  /api/v1/analytics/dashboard/:animalId — Full daily summary (all scores)
 * GET  /api/v1/analytics/herd-summary  — All animals, all scores, one call
 */

const router = require('express').Router();
const auth   = require('../middleware/auth');
const { CattleTag, LocationHistory } = require('../models/CattleTag');
const { WaterPoint, FeedZone, PastureRotation } = require('../models/Analytics');
const {
  getDayHistory, totalDistanceKm,
  activeHours, grazingHours,
  movementPattern, clamp100,
} = require('../analytics/analyticsEngine');

router.use(auth);
const ok  = (res, data, meta = {}) => res.json({ success: true, data, ...meta });
const err = (res, msg, code = 400) => res.status(code).json({ success: false, error: msg });
function todayStr() { return new Date().toISOString().slice(0, 10); }

// ── Water point config ────────────────────────────────────────────────────
router.get('/config/water-points', async (req, res) => {
  try { ok(res, await WaterPoint.find().lean()); } catch (e) { err(res, e.message, 500); }
});

router.post('/config/water-points', async (req, res) => {
  try {
    const { name, latitude, longitude, farmId } = req.body;
    if (!name || !latitude || !longitude) return err(res, 'name, latitude, longitude required');
    const wp = await WaterPoint.create({ name, latitude, longitude, farmId });
    ok(res, wp);
  } catch (e) { err(res, e.message, 500); }
});

router.delete('/config/water-points/:id', async (req, res) => {
  try {
    await WaterPoint.findByIdAndDelete(req.params.id);
    ok(res, { deleted: true });
  } catch (e) { err(res, e.message, 500); }
});

// ── Feed zone config ──────────────────────────────────────────────────────
router.get('/config/feed-zones', async (req, res) => {
  try { ok(res, await FeedZone.find().lean()); } catch (e) { err(res, e.message, 500); }
});

router.post('/config/feed-zones', async (req, res) => {
  try {
    const { name, latitude, longitude, farmId } = req.body;
    if (!name || !latitude || !longitude) return err(res, 'name, latitude, longitude required');
    const fz = await FeedZone.create({ name, latitude, longitude, farmId });
    ok(res, fz);
  } catch (e) { err(res, e.message, 500); }
});

// ── Pasture rotation schedule ─────────────────────────────────────────────
router.get('/config/pasture-rotation', async (req, res) => {
  try {
    ok(res, await PastureRotation.find().populate('geofenceId', 'name').lean());
  } catch (e) { err(res, e.message, 500); }
});

router.post('/config/pasture-rotation', async (req, res) => {
  try {
    const r = await PastureRotation.create(req.body);
    ok(res, r);
  } catch (e) { err(res, e.message, 500); }
});

// ── Daily dashboard for one animal — all key scores in one call ───────────
router.get('/analytics/dashboard/:animalId', async (req, res) => {
  try {
    const date  = req.query.date || todayStr();
    const imei  = req.params.animalId;
    const tag   = await CattleTag.findOne({
      $or: [{ imei }, { tagId: imei }]
    }).populate('geofenceId', 'name').lean();

    if (!tag) return err(res, 'Tag not found', 404);
    const resolvedImei = tag.imei;
    const pts  = await getDayHistory(resolvedImei, date);

    const dist      = pts.length > 1 ? Math.round(totalDistanceKm(pts) * 100) / 100 : 0;
    const active    = Math.round(activeHours(pts) * 100) / 100;
    const grazing   = Math.round(grazingHours(pts) * 100) / 100;
    const pattern   = movementPattern(pts);
    const speeds    = pts.map(p => p.speed || 0);
    const maxSpeed  = speeds.length ? Math.round(Math.max(...speeds) * 100) / 100 : 0;
    const avgSpeed  = speeds.length ? Math.round(speeds.reduce((a, b) => a + b, 0) / speeds.length * 100) / 100 : 0;

    ok(res, {
      animal_id:   req.params.animalId,
      imei:        resolvedImei,
      date,

      // Identity
      tag: {
        model:    tag.model,
        firmware: tag.firmware,
        battery:  tag.battery,
        signal:   tag.signal,
        gpsFixed: tag.gpsFixed,
      },

      // Current live state
      live: {
        latitude:       tag.latitude,
        longitude:      tag.longitude,
        speed:          tag.speed,
        behaviourState: tag.behaviourState,
        lastPacketAt:   tag.lastPacketAt,
        alarms:         tag.alarms,
        geofence:       tag.geofenceId?.name || null,
        packetInterval: tag.packetInterval,
      },

      // Daily computed metrics
      daily: {
        distance_km:     dist,
        active_hours:    active,
        grazing_hours:   grazing,
        max_speed_kmh:   maxSpeed,
        avg_speed_kmh:   avgSpeed,
        unusual_speed:   maxSpeed > 12,
        movement_pattern: pattern,
      },

      // API links for full detail
      api_links: {
        activity_score:      `/api/v1/analytics/activity-score/${req.params.animalId}?date=${date}`,
        movement_pattern:    `/api/v1/analytics/movement-pattern/${req.params.animalId}?date=${date}`,
        speed_analysis:      `/api/v1/analytics/speed-analysis/${req.params.animalId}?date=${date}`,
        health_risk:         `/api/v1/analytics/health-risk/${req.params.animalId}?date=${date}`,
        lameness:            `/api/v1/analytics/lameness/${req.params.animalId}`,
        heat_detection:      `/api/v1/analytics/heat-detection/${req.params.animalId}?date=${date}`,
        welfare_score:       `/api/v1/analytics/welfare-score/${req.params.animalId}?date=${date}`,
        productivity_score:  `/api/v1/analytics/productivity-score/${req.params.animalId}?date=${date}`,
        disease_risk:        `/api/v1/analytics/disease-risk/${req.params.animalId}?date=${date}`,
        insurance_risk:      `/api/v1/analytics/insurance-risk/${req.params.animalId}`,
        behaviour_anomaly:   `/api/v1/analytics/behaviour-anomaly/${req.params.animalId}?date=${date}`,
        isolation:           `/api/v1/analytics/isolation/${req.params.animalId}`,
        escape_risk:         `/api/v1/analytics/escape-risk/${req.params.animalId}`,
        water_visits:        `/api/v1/analytics/water-visits/${req.params.animalId}?date=${date}`,
        breeding_window:     `/api/v1/analytics/breeding-window/${req.params.animalId}`,
        recovery:            `/api/v1/analytics/recovery/${req.params.animalId}`,
      },
    });
  } catch (e) { err(res, e.message, 500); }
});

// ── Herd summary — one row per animal ────────────────────────────────────
router.get('/analytics/herd-summary', async (req, res) => {
  try {
    const date = req.query.date || todayStr();
    const tags = await CattleTag.find({}).lean();

    const rows = await Promise.all(tags.map(async tag => {
      const pts     = await getDayHistory(tag.imei, date);
      const dist    = pts.length > 1 ? Math.round(totalDistanceKm(pts) * 100) / 100 : 0;
      const active  = Math.round(activeHours(pts) * 100) / 100;
      const grazing = Math.round(grazingHours(pts) * 100) / 100;
      return {
        imei:           tag.imei,
        animal_id:      tag.tagId,
        behaviourState: tag.behaviourState,
        battery:        tag.battery,
        latitude:       tag.latitude,
        longitude:      tag.longitude,
        last_seen:      tag.lastPacketAt,
        distance_km:    dist,
        active_hours:   active,
        grazing_hours:  grazing,
        alarms:         tag.alarms,
      };
    }));

    ok(res, rows, { date, count: rows.length });
  } catch (e) { err(res, e.message, 500); }
});

module.exports = router;
