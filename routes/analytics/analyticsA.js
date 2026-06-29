'use strict';
/**
 * Analytics API Routes — Group A (APIs 1–10)
 *
 * All computations use LocationHistory data from HCS048 LOCA packets.
 * Input fields used per API:
 *   speed     → GDATA speed (km/h)
 *   latitude  → GDATA latitude
 *   longitude → GDATA longitude
 *   heading   → GDATA heading (degrees)
 *   timestamp → server receive timestamp / gpsTimestamp
 *   battery   → STATUS field
 */

const router  = require('express').Router();
const auth      = require('../../middleware/auth');
const {
  getDayHistory, getNDayHistory,
  totalDistanceKm, speedVariabilityIndex,
  activeHours, movementCount,
  movementPattern, grazingHours,
  grazingZoneMap, herdAverages,
  sevenDayAvgDistance, nDayAvgActivity,
  accelerationEvents, clamp100,
} = require('../analytics/analyticsEngine');
const { CattleTag, LocationHistory, AlarmEvent } = require('../../models/CattleTag');
const { DailyAnalytics, PastureRotation } = require('../../models/Analytics');

router.use(auth);

const ok  = (res, data, meta = {}) => res.json({ success: true, data, ...meta });
const err = (res, msg, code = 400) => res.status(code).json({ success: false, error: msg });

function todayStr() { return new Date().toISOString().slice(0, 10); }
async function resolveImei(animalId) {
  const tag = await CattleTag.findOne({ tagId: animalId }).select('imei').lean();
  return tag?.imei || animalId;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 1 — Activity Score
// GET /api/v1/analytics/activity-score/:animalId?date=YYYY-MM-DD
//
// Score = (dayDist/herdAvgDist)*40 + (activeHrs/herdAvgActive)*30
//       + (moves/herdAvgMoves)*20  + (speedVariabilityIndex)*10
// Capped at 100. Status: Low <40, Normal 40–75, High >75
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/activity-score/:animalId', async (req, res) => {
  try {
    const imei  = await resolveImei(req.params.animalId);
    const date  = req.query.date || todayStr();
    const pts   = await getDayHistory(imei, date);
    if (pts.length < 2) return ok(res, { activity_score: 0, status: 'Insufficient data' });

    const [dist, hrs, moves, svi, herd] = await Promise.all([
      Promise.resolve(totalDistanceKm(pts)),
      Promise.resolve(activeHours(pts)),
      Promise.resolve(movementCount(pts)),
      Promise.resolve(speedVariabilityIndex(pts)),
      herdAverages(date, imei),
    ]);

    const score = clamp100(
      (dist  / herd.distance)    * 40 +
      (hrs   / herd.activeHours) * 30 +
      (moves / herd.movements)   * 20 +
      Math.min(svi, 1)           * 10
    );

    const status = score < 40 ? 'Low' : score <= 75 ? 'Normal' : 'High';

    ok(res, {
      animal_id:      req.params.animalId,
      date,
      activity_score: score,
      status,
      breakdown: {
        distance_km:         Math.round(dist * 100) / 100,
        active_hours:        Math.round(hrs  * 100) / 100,
        movement_count:      moves,
        speed_variability:   Math.round(svi * 100) / 100,
        herd_avg_distance:   Math.round(herd.distance    * 100) / 100,
        herd_avg_active_hrs: Math.round(herd.activeHours * 100) / 100,
        herd_avg_movements:  Math.round(herd.movements),
      },
    });
  } catch (e) { err(res, e.message, 500); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 2 — Movement Pattern
// GET /api/v1/analytics/movement-pattern/:animalId?date=YYYY-MM-DD
//
// Classifies every 5-min window: Resting/Grazing/Walking/Running (% of day)
// Speed thresholds: <0.2 Resting | 0.2–1.0 Grazing | 1.0–5 Walking | >5 Running
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/movement-pattern/:animalId', async (req, res) => {
  try {
    const imei = await resolveImei(req.params.animalId);
    const date = req.query.date || todayStr();
    const pts  = await getDayHistory(imei, date);
    if (pts.length < 2) return ok(res, { resting: 0, grazing: 0, walking: 0, running: 0 });

    const pattern = movementPattern(pts);
    ok(res, {
      animal_id: req.params.animalId,
      date,
      ...pattern,
      unit: '% of day',
    });
  } catch (e) { err(res, e.message, 500); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 3 — Daily Distance Travelled
// GET /api/v1/analytics/daily-distance/:animalId?date=YYYY-MM-DD
//
// Uses Haversine formula: Σ distance(point_n → point_n+1) for the day
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/daily-distance/:animalId', async (req, res) => {
  try {
    const imei = await resolveImei(req.params.animalId);
    const date = req.query.date || todayStr();
    const pts  = await getDayHistory(imei, date);

    const distance_km = pts.length > 1 ? Math.round(totalDistanceKm(pts) * 100) / 100 : 0;

    // 7-day trend
    const days = {};
    const hist = await getNDayHistory(imei, 7);
    hist.forEach(p => {
      const d = new Date(p.timestamp).toISOString().slice(0, 10);
      if (!days[d]) days[d] = [];
      days[d].push(p);
    });
    const trend = Object.entries(days).map(([d, points]) => ({
      date: d, distance_km: Math.round(totalDistanceKm(points) * 100) / 100,
    })).sort((a, b) => a.date.localeCompare(b.date));

    ok(res, { animal_id: req.params.animalId, date, distance_km, trend_7day: trend });
  } catch (e) { err(res, e.message, 500); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 4 — Speed Analysis
// GET /api/v1/analytics/speed-analysis/:animalId?date=YYYY-MM-DD
//
// Returns avg speed, max speed, acceleration events.
// Flags max speed > 12 km/h as unusual.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/speed-analysis/:animalId', async (req, res) => {
  try {
    const imei = await resolveImei(req.params.animalId);
    const date = req.query.date || todayStr();
    const pts  = await getDayHistory(imei, date);
    if (pts.length < 2) return ok(res, { animal_id: req.params.animalId, date, avg_speed: 0, max_speed: 0 });

    const speeds  = pts.map(p => p.speed || 0);
    const avgSpeed = Math.round((speeds.reduce((a, b) => a + b, 0) / speeds.length) * 100) / 100;
    const maxSpeed = Math.round(Math.max(...speeds) * 100) / 100;
    const accEvents = accelerationEvents(pts);

    ok(res, {
      animal_id:          req.params.animalId,
      date,
      avg_speed_kmh:      avgSpeed,
      max_speed_kmh:      maxSpeed,
      unusual_speed_flag: maxSpeed > 12,
      acceleration_events:{
        count:   accEvents.length,
        events:  accEvents.slice(0, 20),
      },
      speed_histogram: buildSpeedHistogram(speeds),
    });
  } catch (e) { err(res, e.message, 500); }
});

function buildSpeedHistogram(speeds) {
  const buckets = { '0-1': 0, '1-3': 0, '3-5': 0, '5-10': 0, '10+': 0 };
  for (const s of speeds) {
    if      (s < 1)  buckets['0-1']++;
    else if (s < 3)  buckets['1-3']++;
    else if (s < 5)  buckets['3-5']++;
    else if (s < 10) buckets['5-10']++;
    else             buckets['10+']++;
  }
  return buckets;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 5 — Grazing Time
// GET /api/v1/analytics/grazing-time/:animalId?date=YYYY-MM-DD
//
// Speed 0.1–1 km/h AND direction changes >15° AND within 30 m radius
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/grazing-time/:animalId', async (req, res) => {
  try {
    const imei  = await resolveImei(req.params.animalId);
    const date  = req.query.date || todayStr();
    const pts   = await getDayHistory(imei, date);
    const hours = Math.round(grazingHours(pts) * 100) / 100;

    // 7-day trend
    const hist = await getNDayHistory(imei, 7);
    const days  = {};
    hist.forEach(p => {
      const d = new Date(p.timestamp).toISOString().slice(0, 10);
      if (!days[d]) days[d] = [];
      days[d].push(p);
    });
    const trend = Object.entries(days).map(([d, dp]) => ({
      date: d, grazing_hours: Math.round(grazingHours(dp) * 100) / 100,
    })).sort((a, b) => a.date.localeCompare(b.date));

    ok(res, { animal_id: req.params.animalId, date, grazing_hours: hours, trend_7day: trend });
  } catch (e) { err(res, e.message, 500); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 6 — Grazing Zone Utilisation
// GET /api/v1/analytics/grazing-zones/:animalId?date=YYYY-MM-DD
//
// Pasture divided into 50 m × 50 m grid cells.
// Time spent (minutes) per cell returned as heatmap data.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/grazing-zones/:animalId', async (req, res) => {
  try {
    const imei = await resolveImei(req.params.animalId);
    const date = req.query.date || todayStr();
    const pts  = await getDayHistory(imei, date);
    if (pts.length < 2) return ok(res, { animal_id: req.params.animalId, zones: {} });

    const zoneMap   = grazingZoneMap(pts);
    const totalMins = Object.values(zoneMap).reduce((a, b) => a + b, 0) || 1;

    // Sort by time desc, label top zones A, B, C...
    const sorted = Object.entries(zoneMap)
      .sort(([, a], [, b]) => b - a)
      .map(([key, mins], i) => ({
        zone_id:     String.fromCharCode(65 + i),   // A, B, C...
        grid_key:    key,
        minutes:     Math.round(mins),
        percentage:  Math.round(mins / totalMins * 100),
      }));

    ok(res, {
      animal_id:  req.params.animalId,
      date,
      grid_size_m: 50,
      zones:       sorted,
      heatmap_summary: sorted.slice(0, 3).reduce((o, z) => {
        o[`zone_${z.zone_id}`] = z.percentage; return o;
      }, {}),
    });
  } catch (e) { err(res, e.message, 500); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 7 — Pasture Rotation Effectiveness
// GET /api/v1/analytics/pasture-rotation/:animalId
//
// Compliance % = actual days in paddock / planned days × 100
// Requires PastureRotation schedule configured by farm manager.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/pasture-rotation/:animalId', async (req, res) => {
  try {
    const imei = await resolveImei(req.params.animalId);

    const rotations = await PastureRotation.find({ assignedTags: imei })
      .populate('geofenceId', 'name').lean();

    const results = rotations.map(r => {
      const planned = r.plannedEndDate - r.plannedStartDate;
      const actual  = r.actualEndDate && r.actualStartDate
        ? r.actualEndDate - r.actualStartDate
        : (r.actualStartDate ? Date.now() - r.actualStartDate : 0);
      const compliance = planned > 0 ? Math.round(actual / planned * 100) : null;

      return {
        paddock:          r.paddockName,
        geofence:         r.geofenceId?.name,
        planned_start:    r.plannedStartDate,
        planned_end:      r.plannedEndDate,
        actual_start:     r.actualStartDate,
        actual_end:       r.actualEndDate,
        compliance_pct:   compliance,
        status:           compliance === null ? 'Not started'
                        : compliance < 80     ? 'Under-rotated'
                        : compliance <= 120   ? 'On schedule'
                        :                       'Over-rotated',
      };
    });

    const avgCompliance = results.filter(r => r.compliance_pct !== null).length
      ? Math.round(results.filter(r => r.compliance_pct !== null)
          .reduce((s, r) => s + r.compliance_pct, 0) /
          results.filter(r => r.compliance_pct !== null).length)
      : null;

    ok(res, { animal_id: req.params.animalId, overall_compliance_pct: avgCompliance, rotations: results });
  } catch (e) { err(res, e.message, 500); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 8 — Inactivity Detection
// GET /api/v1/analytics/inactivity/:animalId?date=YYYY-MM-DD
//
// Alert if current active hours < 40% of 7-day average for > 6 hours
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/inactivity/:animalId', async (req, res) => {
  try {
    const imei   = await resolveImei(req.params.animalId);
    const date   = req.query.date || todayStr();
    const pts    = await getDayHistory(imei, date);
    const today  = activeHours(pts);
    const avg7   = await nDayAvgActivity(imei, 7);

    const ratio    = avg7 > 0 ? today / avg7 : 1;
    const triggered = ratio < 0.40 && today < (24 - 6);  // low AND been running > 6h

    const risk = ratio < 0.25 ? 'Critical'
               : ratio < 0.40 ? 'High'
               : ratio < 0.70 ? 'Medium'
               :                 'Normal';

    ok(res, {
      animal_id:           req.params.animalId,
      date,
      today_active_hours:  Math.round(today * 100) / 100,
      avg_7day_hours:      Math.round(avg7  * 100) / 100,
      activity_ratio:      Math.round(ratio * 100) / 100,
      risk,
      alert:   triggered ? 'Inactivity' : null,
      triggered,
    });
  } catch (e) { err(res, e.message, 500); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 9 — Abnormal Activity
// GET /api/v1/analytics/abnormal-activity/:animalId
//
// Detects if current 2-hour window activity > 200% of normal 2-hour pattern
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/abnormal-activity/:animalId', async (req, res) => {
  try {
    const imei = await resolveImei(req.params.animalId);
    const now  = new Date();
    const twoHrsAgo = new Date(now - 2 * 3600 * 1000);


    const recent = await LocationHistory.find({
      imei, timestamp: { $gte: twoHrsAgo, $lte: now },
    }).sort({ timestamp: 1 }).lean();

    const recentDist = totalDistanceKm(recent);

    // Compare to 7-day average 2-hour distance
    const hist = await getNDayHistory(imei, 7);
    const windows = [];
    for (let i = 0; i < hist.length; i++) {
      const windowEnd   = new Date(hist[i].timestamp);
      const windowStart = new Date(windowEnd - 2 * 3600 * 1000);
      const windowPts   = hist.filter(p =>
        new Date(p.timestamp) >= windowStart && new Date(p.timestamp) <= windowEnd
      );
      if (windowPts.length > 1) windows.push(totalDistanceKm(windowPts));
    }
    const avg2h = windows.length ? windows.reduce((a, b) => a + b, 0) / windows.length : 0;
    const ratio  = avg2h > 0 ? recentDist / avg2h : 1;

    const detected = ratio > 2.0;
    const possibleCauses = detected
      ? ['Stress', 'Predation attempt', 'Theft', 'Estrus / heat', 'External disturbance']
      : [];

    ok(res, {
      animal_id:          req.params.animalId,
      window_hours:       2,
      recent_distance_km: Math.round(recentDist * 100) / 100,
      avg_2h_distance_km: Math.round(avg2h * 100) / 100,
      activity_ratio:     Math.round(ratio * 100) / 100,
      anomaly_detected:   detected,
      possible_causes:    possibleCauses,
      timestamp:          now,
    });
  } catch (e) { err(res, e.message, 500); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 10 — Health Risk Score
// GET /api/v1/analytics/health-risk/:animalId?date=YYYY-MM-DD
//
// Score = 30% activityDrop + 25% isolation + 20% geofenceAnomalies
//       + 15% grazingReduction + 10% historicalIncidents
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/health-risk/:animalId', async (req, res) => {
  try {
    const imei = await resolveImei(req.params.animalId);
    const date = req.query.date || todayStr();


    const pts   = await getDayHistory(imei, date);
    const today = activeHours(pts);
    const avg7  = await nDayAvgActivity(imei, 7);
    const activityDropRatio = avg7 > 0 ? Math.max(0, 1 - today / avg7) : 0;

    const tag = await CattleTag.findOne({ imei }).lean();
    const isolatedNow = tag?.alarms?.perimeterBreach ? 0 : 0;

    // Geofence alarm count today
    const start = new Date(date);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(date);
    end.setUTCHours(23, 59, 59, 999);

    const geoAlarms = await AlarmEvent.countDocuments({
      imei, type: 'PERIMETER_BREACH', timestamp: { $gte: start, $lte: end },
    });
    const geoScore = Math.min(1, geoAlarms / 5);

    const grazingToday = grazingHours(pts);
    const hist = await getNDayHistory(imei, 7);
    const days = {};
    hist.forEach(p => {
      const d = new Date(p.timestamp).toISOString().slice(0, 10);
      if (!days[d]) days[d] = [];
      days[d].push(p);
    });
    const avgGrazing = Object.values(days).reduce((s, dp) => s + grazingHours(dp), 0) /
                       (Object.keys(days).length || 1);
    const grazingDropRatio = avgGrazing > 0 ? Math.max(0, 1 - grazingToday / avgGrazing) : 0;

    const incidents = await AlarmEvent.countDocuments({ imei });
    const historicalScore = Math.min(1, incidents / 20);

    const isolationScore = tag?.alarms?.perimeterBreach ? 0.5 : 0;

    const risk_score = clamp100(
      activityDropRatio * 30 +
      isolationScore    * 25 +
      geoScore          * 20 +
      grazingDropRatio  * 15 +
      historicalScore   * 10
    );

    const risk = risk_score >= 75 ? 'High'
               : risk_score >= 45 ? 'Medium'
               :                    'Low';

    ok(res, {
      animal_id:  req.params.animalId,
      date,
      risk_score,
      risk,
      components: {
        activity_drop:        Math.round(activityDropRatio * 30),
        isolation:            Math.round(isolationScore    * 25),
        geofence_anomalies:   Math.round(geoScore          * 20),
        grazing_reduction:    Math.round(grazingDropRatio  * 15),
        historical_incidents: Math.round(historicalScore   * 10),
      },
    });
  } catch (e) { err(res, e.message, 500); }
});

module.exports = router;
