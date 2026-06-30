'use strict';
/**
 * Analytics API Routes — Group B (APIs 11–20)
 */

const router = require('express').Router();
const auth   = require('../../middleware/auth');
const {
  getDayHistory, getNDayHistory,
  totalDistanceKm, activeHours,
  grazingHours, haversineM,
  clamp100, isNightHour,
} = require('../analytics/analyticsEngine');
const { CattleTag, LocationHistory, AlarmEvent, Geofence } = require('../../models/CattleTag');
const { HeatEvent } = require('../../models/Analytics');

router.use(auth);

const ok  = (res, data, meta = {}) => res.json({ success: true, data, ...meta });
const err = (res, msg, code = 400) => res.status(code).json({ success: false, error: msg });

function todayStr() { return new Date().toISOString().slice(0, 10); }
async function resolveImei(animalId) {
  const tag = await CattleTag.findOne({ tagId: animalId }).select('imei').lean();
  return tag?.imei || animalId;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 11 — Lameness Detection
// GET /api/v1/analytics/lameness/:animalId
//
// Triggers when ALL three conditions persist for ≥ 3 days:
//   Distance reduction > 40% vs 7-day baseline
//   Average speed reduction > 30% vs 7-day baseline
//   Both indicators persist for > 3 consecutive days
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/lameness/:animalId', async (req, res) => {
  try {
    const imei = await resolveImei(req.params.animalId);
    const hist = await getNDayHistory(imei, 10);
    if (!hist.length) return ok(res, { suspected_lameness: false, reason: 'Insufficient data' });

    const dayMap = {};
    hist.forEach(p => {
      const d = new Date(p.timestamp).toISOString().slice(0, 10);
      if (!dayMap[d]) dayMap[d] = [];
      dayMap[d].push(p);
    });

    const sortedDays = Object.keys(dayMap).sort();
    if (sortedDays.length < 4) return ok(res, { suspected_lameness: false, reason: 'Need ≥ 4 days data' });

    // 7-day baseline = first 7 days
    const baselineDays   = sortedDays.slice(0, 7);
    const recentDays     = sortedDays.slice(-3);

    const baselineAvgDist  = baselineDays.reduce((s, d) => s + totalDistanceKm(dayMap[d]), 0) / baselineDays.length;
    const baselineAvgSpeed = baselineDays.reduce((s, d) => {
      const speeds = dayMap[d].map(p => p.speed || 0);
      return s + (speeds.reduce((a, b) => a + b, 0) / (speeds.length || 1));
    }, 0) / baselineDays.length;

    let lameDays = 0;
    const recentMetrics = recentDays.map(d => {
      const pts = dayMap[d];
      const dist = totalDistanceKm(pts);
      const speeds = pts.map(p => p.speed || 0);
      const avgSpeed = speeds.reduce((a, b) => a + b, 0) / (speeds.length || 1);
      const distDropPct  = baselineAvgDist  > 0 ? (1 - dist     / baselineAvgDist)  * 100 : 0;
      const speedDropPct = baselineAvgSpeed > 0 ? (1 - avgSpeed  / baselineAvgSpeed) * 100 : 0;

      const lame = distDropPct > 40 && speedDropPct > 30;
      if (lame) lameDays++;
      return { date: d, dist_km: Math.round(dist * 100) / 100, avg_speed: Math.round(avgSpeed * 100) / 100, dist_drop_pct: Math.round(distDropPct), speed_drop_pct: Math.round(speedDropPct), lame_indicator: lame };
    });

    const suspected = lameDays >= 3;

    ok(res, {
      animal_id:          req.params.animalId,
      suspected_lameness: suspected,
      lame_days_in_last_3: lameDays,
      baseline_avg_distance_km: Math.round(baselineAvgDist  * 100) / 100,
      baseline_avg_speed_kmh:   Math.round(baselineAvgSpeed * 100) / 100,
      recent_days:        recentMetrics,
    });
  } catch (e) { err(res, e.message, 500); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 12 — Heat Detection
// GET /api/v1/analytics/heat-detection/:animalId?date=YYYY-MM-DD
//
// Indicators: movement > 180% normal, running events increase,
//             night activity increase, restlessness score
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/heat-detection/:animalId', async (req, res) => {
  try {
    const imei = await resolveImei(req.params.animalId);
    const date = req.query.date || todayStr();

    const todayPts = await getDayHistory(imei, date);
    const hist     = await getNDayHistory(imei, 14);

    const todayDist = totalDistanceKm(todayPts);
    const todayRunning = todayPts.filter(p => (p.speed || 0) > 5).length;
    const todayNight   = todayPts.filter(p => isNightHour(p.timestamp)).length;

    // 14-day baseline
    const dayMap = {};
    hist.forEach(p => {
      const d = new Date(p.timestamp).toISOString().slice(0, 10);
      if (!dayMap[d]) dayMap[d] = [];
      dayMap[d].push(p);
    });

    const allDays = Object.values(dayMap);
    const avgDist    = allDays.reduce((s, pts) => s + totalDistanceKm(pts), 0) / (allDays.length || 1);
    const avgRunning = allDays.reduce((s, pts) => s + pts.filter(p => (p.speed || 0) > 5).length, 0) / (allDays.length || 1);
    const avgNight   = allDays.reduce((s, pts) => s + pts.filter(p => isNightHour(p.timestamp)).length, 0) / (allDays.length || 1);

    const movementRatio  = avgDist    > 0 ? todayDist    / avgDist    : 1;
    const runningRatio   = avgRunning > 0 ? todayRunning / avgRunning : 1;
    const nightRatio     = avgNight   > 0 ? todayNight   / avgNight   : 1;

    // Restlessness: coefficient of variation of speed
    const speeds  = todayPts.map(p => p.speed || 0);
    const meanSpd = speeds.reduce((a, b) => a + b, 0) / (speeds.length || 1);
    const varSpd  = speeds.reduce((a, b) => a + (b - meanSpd) ** 2, 0) / (speeds.length || 1);
    const restlessnessScore = meanSpd > 0 ? Math.sqrt(varSpd) / meanSpd : 0;

    // Weighted probability
    const prob = clamp100(
      Math.min(movementRatio - 1, 1)  * 40 +
      Math.min(runningRatio  - 1, 1)  * 25 +
      Math.min(nightRatio    - 1, 1)  * 20 +
      Math.min(restlessnessScore, 1)  * 15
    );

    const inHeat = prob >= 70;

    // Log heat event if detected
    if (inHeat) {
      const existingToday = await HeatEvent.findOne({
        imei, detectedAt: { $gte: new Date(date + 'T00:00:00Z') },
      });
      if (!existingToday) {
        await HeatEvent.create({
          imei,
          detectedAt:           new Date(),
          heatProbability:      prob,
          optimalBreedingStart: new Date(Date.now() + 12 * 3600 * 1000),
          optimalBreedingEnd:   new Date(Date.now() + 18 * 3600 * 1000),
        });
      }
    }

    ok(res, {
      animal_id:         req.params.animalId,
      date,
      heat_probability:  prob,
      in_heat:           inHeat,
      indicators: {
        movement_vs_normal_pct: Math.round(movementRatio * 100),
        running_vs_normal_pct:  Math.round(runningRatio  * 100),
        night_activity_pct:     Math.round(nightRatio    * 100),
        restlessness_score:     Math.round(restlessnessScore * 100) / 100,
      },
    });
  } catch (e) { err(res, e.message, 500); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 13 — Breeding Window Prediction
// GET /api/v1/analytics/breeding-window/:animalId
//
// Optimal window = heat detection timestamp + 12–18 hours
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/breeding-window/:animalId', async (req, res) => {
  try {
    const imei  = await resolveImei(req.params.animalId);
    const event = await HeatEvent.findOne({ imei }).sort({ detectedAt: -1 }).lean();

    if (!event) {
      return ok(res, { animal_id: req.params.animalId, heat_detected: false, optimal_time: null });
    }

    ok(res, {
      animal_id:           req.params.animalId,
      heat_detected:       true,
      heat_detected_at:    event.detectedAt,
      heat_probability:    event.heatProbability,
      optimal_time:        event.optimalBreedingStart,
      optimal_window: {
        start: event.optimalBreedingStart,
        end:   event.optimalBreedingEnd,
        hours: '12–18 hours after heat detection',
      },
      confirmed: event.confirmed,
    });
  } catch (e) { err(res, e.message, 500); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 14 — Fertility Behaviour
// GET /api/v1/analytics/fertility/:animalId
//
// Tracks heat frequency, duration, interval; calculates regularity score
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/fertility/:animalId', async (req, res) => {
  try {
    const imei   = await resolveImei(req.params.animalId);
    const events = await HeatEvent.find({ imei }).sort({ detectedAt: 1 }).lean();

    if (!events.length) {
      return ok(res, { animal_id: req.params.animalId, heat_count: 0, regularity_score: null });
    }

    // Inter-heat intervals (days)
    const intervals = [];
    for (let i = 1; i < events.length; i++) {
      intervals.push(
        (events[i].detectedAt - events[i - 1].detectedAt) / (1000 * 3600 * 24)
      );
    }

    // Expected bovine cycle: ~21 days (range 17–24)
    const EXPECTED_CYCLE = 21;
    const avgInterval = intervals.length
      ? intervals.reduce((a, b) => a + b, 0) / intervals.length : null;

    const deviations = intervals.map(i => Math.abs(i - EXPECTED_CYCLE));
    const avgDev = deviations.length
      ? deviations.reduce((a, b) => a + b, 0) / deviations.length : null;

    // Regularity score: 100 = perfect 21-day cycle, decreases with deviation
    const regularityScore = avgDev !== null
      ? clamp100(100 - (avgDev / EXPECTED_CYCLE) * 100) : null;

    ok(res, {
      animal_id:          req.params.animalId,
      heat_count:         events.length,
      first_heat:         events[0].detectedAt,
      last_heat:          events[events.length - 1].detectedAt,
      avg_interval_days:  avgInterval !== null ? Math.round(avgInterval * 10) / 10 : null,
      expected_cycle_days: EXPECTED_CYCLE,
      avg_deviation_days: avgDev !== null ? Math.round(avgDev * 10) / 10 : null,
      regularity_score:   regularityScore,
      heat_events:        events.map(e => ({
        detected_at:      e.detectedAt,
        probability:      e.heatProbability,
        confirmed:        e.confirmed,
      })),
    });
  } catch (e) { err(res, e.message, 500); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 15 — Herd Cohesion
// GET /api/v1/analytics/herd-cohesion
//
// Centroid = average GPS of all active tags.
// Cohesion score = 100 − normalised average distance from centroid.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/herd-cohesion', async (req, res) => {
  try {
    const cutoff = new Date(Date.now() - 10 * 60 * 1000);  // active last 10 min
    const tags   = await CattleTag.find({ lastPacketAt: { $gte: cutoff } })
      .select('imei tagId latitude longitude').lean();

    if (tags.length < 2) {
      return ok(res, { cohesion_score: null, reason: 'Need ≥ 2 active tags' });
    }

    const positions = tags.map(t => ({ latitude: t.latitude, longitude: t.longitude }));
    const lat = positions.reduce((s, p) => s + p.latitude,  0) / positions.length;
    const lng = positions.reduce((s, p) => s + p.longitude, 0) / positions.length;

    const distances = tags.map(t => ({
      imei:       t.imei,
      tagId:      t.tagId,
      dist_m:     Math.round(haversineM(lat, lng, t.latitude, t.longitude)),
    }));

    const avgDist = distances.reduce((s, d) => s + d.dist_m, 0) / distances.length;
    // Score: 0 m apart = 100, 500 m apart = ~0
    const cohesion_score = clamp100(100 - (avgDist / 500) * 100);

    ok(res, {
      centroid:       { latitude: Math.round(lat * 1e6) / 1e6, longitude: Math.round(lng * 1e6) / 1e6 },
      tag_count:      tags.length,
      avg_dist_from_centroid_m: Math.round(avgDist),
      cohesion_score,
      animals:        distances.sort((a, b) => b.dist_m - a.dist_m),
    });
  } catch (e) { err(res, e.message, 500); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 16 — Isolation Detection
// GET /api/v1/analytics/isolation/:animalId
//
// Animal is isolated when nearest 3 animals > 150 m away for > 2 hours
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/isolation/:animalId', async (req, res) => {
  try {
    const imei   = await resolveImei(req.params.animalId);
    const twoHrsAgo = new Date(Date.now() - 2 * 3600 * 1000);

    // Get subject's positions over last 2 hours
    const subjectPts = await LocationHistory.find({
      imei, timestamp: { $gte: twoHrsAgo },
    }).sort({ timestamp: 1 }).lean();

    if (!subjectPts.length) return ok(res, { isolated: false, reason: 'No recent data' });

    const otherTags = await CattleTag.find({
      imei:        { $ne: imei },
      lastPacketAt:{ $gte: new Date(Date.now() - 15 * 60 * 1000) },
    }).select('imei latitude longitude').lean();

    if (!otherTags.length) return ok(res, { isolated: true, reason: 'No other active tags' });

    // Check each subject point against 3 nearest tags
    let isolatedCount = 0;

    for (const pt of subjectPts) {
      const dists = otherTags.map(t =>
        haversineM(pt.latitude, pt.longitude, t.latitude, t.longitude)
      ).sort((a, b) => a - b);

      const nearest3avg = dists.slice(0, 3).reduce((s, d) => s + d, 0) / Math.min(3, dists.length);
      if (nearest3avg > 150) isolatedCount++;
    }

    const isolatedFraction = isolatedCount / subjectPts.length;
    const isolated = isolatedFraction > 0.6;  // isolated for > 60% of the 2h window

    ok(res, {
      animal_id:               req.params.animalId,
      isolated,
      isolated_fraction:       Math.round(isolatedFraction * 100),
      window_hours:            2,
      nearest_animals: otherTags.map(t => ({
        imei:   t.imei,
        dist_m: Math.round(haversineM(
          subjectPts[subjectPts.length - 1].latitude,
          subjectPts[subjectPts.length - 1].longitude,
          t.latitude, t.longitude
        )),
      })).sort((a, b) => a.dist_m - b.dist_m).slice(0, 5),
    });
  } catch (e) { err(res, e.message, 500); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 17 — Leader-Follower Analysis
// GET /api/v1/analytics/leader-follower?date=YYYY-MM-DD
//
// Analyses movement sequence: which animal moves first repeatedly.
// Leader index = fraction of movements where this animal led.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/leader-follower', async (req, res) => {
  try {
    const date    = req.query.date || todayStr();
    const allTags = await CattleTag.find({}).select('imei tagId').lean();
    const leadCount = {};
    const totalEvents = { count: 0 };

    // Sample movement onset events at 5-min resolution
    const start = new Date(date + 'T00:00:00Z');
    const end   = new Date(date + 'T23:59:59Z');

    for (let t = start.getTime(); t < end.getTime(); t += 5 * 60 * 1000) {
      const windowStart = new Date(t);
      const windowEnd   = new Date(t + 5 * 60 * 1000);

      const pts = await LocationHistory.find({
        imei:      { $in: allTags.map(t => t.imei) },
        timestamp: { $gte: windowStart, $lt: windowEnd },
      }).sort({ timestamp: 1 }).lean();

      // First animal to start moving in this window
      const mover = pts.find(p => (p.speed || 0) > 0.5);
      if (mover) {
        leadCount[mover.imei] = (leadCount[mover.imei] || 0) + 1;
        totalEvents.count++;
      }
    }

    const results = allTags.map(tag => ({
      imei:          tag.imei,
      animal_id:     tag.tagId,
      lead_count:    leadCount[tag.imei] || 0,
      leader_index:  totalEvents.count > 0
        ? Math.round((leadCount[tag.imei] || 0) / totalEvents.count * 100) : 0,
      role:          (leadCount[tag.imei] || 0) / (totalEvents.count || 1) > 0.2 ? 'Leader' : 'Follower',
    })).sort((a, b) => b.leader_index - a.leader_index);

    ok(res, { date, total_movement_events: totalEvents.count, animals: results });
  } catch (e) { err(res, e.message, 500); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 18 — Social Interaction Score
// GET /api/v1/analytics/social-score/:animalId?date=YYYY-MM-DD
//
// Time within 20–50 m of herd members / total active time
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/social-score/:animalId', async (req, res) => {
  try {
    const imei   = await resolveImei(req.params.animalId);
    const date   = req.query.date || todayStr();
    const subPts = await getDayHistory(imei, date);
    if (subPts.length < 2) return ok(res, { social_score: 0, reason: 'Insufficient data' });

    const otherTags = await CattleTag.find({ imei: { $ne: imei } }).select('imei').lean();
    let socialSecs = 0;
    let totalSecs  = 0;

    for (let i = 0; i < subPts.length - 1; i++) {
      const dt = (new Date(subPts[i + 1].timestamp) - new Date(subPts[i].timestamp)) / 1000;
      totalSecs += dt;

      // Find positions of other animals at this timestamp (within ±2 min)
      const ts = new Date(subPts[i].timestamp);
      const nearby = await LocationHistory.find({
        imei:      { $in: otherTags.map(t => t.imei) },
        timestamp: { $gte: new Date(ts - 120000), $lte: new Date(+ts + 120000) },
      }).lean();

      const inSocialZone = nearby.some(other => {
        const dist = haversineM(
          subPts[i].latitude, subPts[i].longitude,
          other.latitude, other.longitude
        );
        return dist >= 20 && dist <= 50;
      });

      if (inSocialZone) socialSecs += dt;
    }

    const social_score = totalSecs > 0
      ? clamp100(socialSecs / totalSecs * 100) : 0;

    ok(res, {
      animal_id:       req.params.animalId,
      date,
      social_score,
      interaction_hours: Math.round(socialSecs / 3600 * 100) / 100,
      active_hours:      Math.round(totalSecs  / 3600 * 100) / 100,
      proximity_zone:   '20–50 metres',
    });
  } catch (e) { err(res, e.message, 500); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 19 — Geofence Violation
// GET /api/v1/analytics/geofence-violations/:animalId?date=YYYY-MM-DD
//
// GPS outside polygon for > 5 minutes counts as one violation event.
// Source: AlarmEvent collection (PERIMETER_BREACH type, server-computed).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/geofence-violations/:animalId', async (req, res) => {
  try {
    const imei  = await resolveImei(req.params.animalId);
    const date  = req.query.date || todayStr();
    const start = new Date(date + 'T00:00:00Z');
    const end   = new Date(date + 'T23:59:59Z');

    const violations = await AlarmEvent.find({
      imei, type: 'PERIMETER_BREACH',
      timestamp: { $gte: start, $lte: end },
    }).sort({ timestamp: -1 }).lean();

    ok(res, {
      animal_id:       req.params.animalId,
      date,
      violation_count: violations.length,
      violations:      violations.map(v => ({
        timestamp:      v.timestamp,
        latitude:       v.latitude,
        longitude:      v.longitude,
        acknowledged:   v.acknowledged,
        acknowledged_by: v.acknowledgedBy,
      })),
    });
  } catch (e) { err(res, e.message, 500); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 20 — Escape Risk Score
// GET /api/v1/analytics/escape-risk/:animalId
//
// Factors: repeated fence approaches + past violations + night movement
// Score 0–100
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/escape-risk/:animalId', async (req, res) => {
  try {
    const imei = await resolveImei(req.params.animalId);


    const tag = await CattleTag.findOne({ imei }).populate('geofenceId').lean();
    const hist30 = await getNDayHistory(imei, 30);

    // Past violations (30 days)
    const pastViolations = await AlarmEvent.countDocuments({
      imei, type: 'PERIMETER_BREACH',
      timestamp: { $gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) },
    });

    // Night movements (points with speed > 0.5 during night hours)
    const nightMoves = hist30.filter(p => isNightHour(p.timestamp) && (p.speed || 0) > 0.5).length;
    const nightRatio = hist30.length > 0 ? nightMoves / hist30.length : 0;

    // Fence approaches: points within 10 m of geofence perimeter (approximate)
    // Without full polygon math we approximate using perimeter breach alarm frequency
    const approachScore = Math.min(1, pastViolations / 10);

    const risk_score = clamp100(
      approachScore    * 40 +
      Math.min(pastViolations / 15, 1) * 35 +
      Math.min(nightRatio * 3, 1)      * 25
    );

    const risk = risk_score >= 70 ? 'High' : risk_score >= 40 ? 'Medium' : 'Low';

    ok(res, {
      animal_id:           req.params.animalId,
      risk_score,
      risk,
      factors: {
        past_violations_30d: pastViolations,
        night_movement_pct:  Math.round(nightRatio * 100),
        fence_approach_score: Math.round(approachScore * 100),
      },
    });
  } catch (e) { err(res, e.message, 500); }
});

module.exports = router;
