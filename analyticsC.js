'use strict';
/**
 * Analytics API Routes — Group C (APIs 21–30)
 */

const router = require('express').Router();
const auth   = require('../middleware/auth');
const {
  getDayHistory, getNDayHistory,
  totalDistanceKm, activeHours,
  grazingHours, haversineM,
  isNightHour, clamp100,
  WATER_DIST_M,
  grazingZoneMap,
} = require('../analytics/analyticsEngine');
const { CattleTag, LocationHistory, AlarmEvent } = require('../models/CattleTag');
const { WaterPoint, FeedZone, HeatEvent } = require('../models/Analytics');

router.use(auth);

const ok  = (res, data, meta = {}) => res.json({ success: true, data, ...meta });
const err = (res, msg, code = 400) => res.status(code).json({ success: false, error: msg });

function todayStr() { return new Date().toISOString().slice(0, 10); }
async function resolveImei(animalId) {
  const tag = await CattleTag.findOne({ tagId: animalId }).select('imei').lean();
  return tag?.imei || animalId;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 21 — Water Point Visits
// GET /api/v1/analytics/water-visits/:animalId?date=YYYY-MM-DD
//
// Distance < 25 m from configured water source = visit.
// Duration = entry time to exit time.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/water-visits/:animalId', async (req, res) => {
  try {
    const imei   = await resolveImei(req.params.animalId);
    const date   = req.query.date || todayStr();
    const pts    = await getDayHistory(imei, date);
    const points = await WaterPoint.find({ active: true }).lean();

    if (!points.length) return ok(res, { animal_id: req.params.animalId, date, visits: [], note: 'No water points configured' });

    const visits = detectPointVisits(pts, points, WATER_DIST_M);

    ok(res, {
      animal_id:    req.params.animalId,
      date,
      visit_count:  visits.length,
      total_minutes:Math.round(visits.reduce((s, v) => s + v.duration_min, 0)),
      visits,
    });
  } catch (e) { err(res, e.message, 500); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 22 — Feed Zone Visits
// GET /api/v1/analytics/feed-visits/:animalId?date=YYYY-MM-DD
//
// Same proximity logic as water visits (25 m radius).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/feed-visits/:animalId', async (req, res) => {
  try {
    const imei  = await resolveImei(req.params.animalId);
    const date  = req.query.date || todayStr();
    const pts   = await getDayHistory(imei, date);
    const zones = await FeedZone.find({ active: true }).lean();

    if (!zones.length) return ok(res, { animal_id: req.params.animalId, date, visits: [], note: 'No feed zones configured' });

    const visits = detectPointVisits(pts, zones, 25);

    ok(res, {
      animal_id:         req.params.animalId,
      date,
      visit_count:       visits.length,
      total_minutes:     Math.round(visits.reduce((s, v) => s + v.duration_min, 0)),
      feeding_frequency: visits.length,
      visits,
    });
  } catch (e) { err(res, e.message, 500); }
});

// Shared helper: detect entry/exit events for a set of point-of-interest locations
function detectPointVisits(pts, locations, radiusM) {
  const visits = [];
  for (const loc of locations) {
    let inZone = false;
    let entryTime = null;
    let lastTime  = null;

    for (const pt of pts) {
      const dist = haversineM(pt.latitude, pt.longitude, loc.latitude, loc.longitude);
      if (dist < radiusM) {
        if (!inZone) { inZone = true; entryTime = pt.timestamp; }
        lastTime = pt.timestamp;
      } else if (inZone) {
        visits.push({
          location_name: loc.name,
          entry_time:    entryTime,
          exit_time:     lastTime,
          duration_min:  Math.round((new Date(lastTime) - new Date(entryTime)) / 60000),
        });
        inZone = false; entryTime = null; lastTime = null;
      }
    }
    // Close open visit at end of day
    if (inZone && entryTime) {
      visits.push({
        location_name: loc.name,
        entry_time:    entryTime,
        exit_time:     lastTime,
        duration_min:  Math.round((new Date(lastTime) - new Date(entryTime)) / 60000),
      });
    }
  }
  return visits.sort((a, b) => new Date(a.entry_time) - new Date(b.entry_time));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 23 — Theft Detection
// GET /api/v1/analytics/theft-detection
//
// Triggers when: night movement + speed > 10 km/h + leaving farm boundary
//              + multiple animals moving together
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/theft-detection', async (req, res) => {
  try {
    const cutoff  = new Date(Date.now() - 30 * 60 * 1000);   // last 30 min
    const recent  = await LocationHistory.find({ timestamp: { $gte: cutoff } })
      .sort({ timestamp: -1 }).lean();

    // Night check
    const nightPoints = recent.filter(p => isNightHour(p.timestamp));

    // High speed at night
    const highSpeedNight = nightPoints.filter(p => (p.speed || 0) > 10);

    // Breach at night
    const breachAlarms = await AlarmEvent.find({
      type: 'PERIMETER_BREACH',
      timestamp: { $gte: cutoff },
    }).lean();

    // Multiple animals moving together at night (within 50 m of each other)
    const movingNight = nightPoints.filter(p => (p.speed || 0) > 2);
    const uniqueImeis = [...new Set(movingNight.map(p => p.imei))];
    let groupMovement = false;
    if (uniqueImeis.length >= 2) {
      const latest = {};
      for (const p of movingNight) {
        if (!latest[p.imei]) latest[p.imei] = p;
      }
      const pos = Object.values(latest);
      for (let i = 0; i < pos.length && !groupMovement; i++) {
        for (let j = i + 1; j < pos.length; j++) {
          if (haversineM(pos[i].latitude, pos[i].longitude, pos[j].latitude, pos[j].longitude) < 50) {
            groupMovement = true; break;
          }
        }
      }
    }

    // Score components
    const nightFactor      = nightPoints.length > 0 ? 1 : 0;
    const speedFactor      = highSpeedNight.length > 0 ? 1 : 0;
    const breachFactor     = breachAlarms.length > 0 ? 1 : 0;
    const groupFactor      = groupMovement ? 1 : 0;

    const theft_probability = clamp100(
      nightFactor  * 25 +
      speedFactor  * 30 +
      breachFactor * 30 +
      groupFactor  * 15
    );

    ok(res, {
      theft_probability,
      alert:        theft_probability >= 75 ? 'THEFT_RISK' : null,
      factors: {
        night_movement:         nightPoints.length > 0,
        high_speed_night:       highSpeedNight.length,
        perimeter_breach:       breachAlarms.length > 0,
        group_movement_detected: groupMovement,
        animals_involved:       uniqueImeis,
      },
      timestamp: new Date(),
    });
  } catch (e) { err(res, e.message, 500); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 24 — Missing Animal
// GET /api/v1/analytics/missing-animals?threshold_minutes=60
//
// No location update beyond threshold OR no herd proximity
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/missing-animals', async (req, res) => {
  try {
    const thresholdMin = Number(req.query.threshold_minutes || 60);
    const cutoff = new Date(Date.now() - thresholdMin * 60 * 1000);

    const missing = await CattleTag.find({ lastPacketAt: { $lt: cutoff } })
      .select('imei tagId lastPacketAt latitude longitude behaviourState battery').lean();

    ok(res, {
      threshold_minutes: thresholdMin,
      missing_count:     missing.length,
      missing_animals:   missing.map(t => ({
        imei:             t.imei,
        animal_id:        t.tagId,
        last_seen:        t.lastPacketAt,
        minutes_missing:  Math.round((Date.now() - new Date(t.lastPacketAt)) / 60000),
        last_latitude:    t.latitude,
        last_longitude:   t.longitude,
        last_behaviour:   t.behaviourState,
        battery:          t.battery,
      })),
    });
  } catch (e) { err(res, e.message, 500); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 25 — Animal Recovery
// GET /api/v1/analytics/recovery/:animalId
//
// Last known location + last 24h route + movement direction (heading)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/recovery/:animalId', async (req, res) => {
  try {
    const imei = await resolveImei(req.params.animalId);
    const tag  = await CattleTag.findOne({ imei }).lean();
    if (!tag) return err(res, 'Tag not found', 404);

    const hist24 = await getNDayHistory(imei, 1);
    const last   = hist24[hist24.length - 1];

    ok(res, {
      animal_id:       req.params.animalId,
      imei,
      last_known: {
        latitude:    tag.latitude,
        longitude:   tag.longitude,
        timestamp:   tag.lastPacketAt,
        battery:     tag.battery,
        heading:     tag.heading,
        speed:       tag.speed,
      },
      last_movement_direction: last?.heading !== undefined
        ? headingToCompass(last.heading) : null,
      last_24h_route: {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: hist24.map(p => [p.longitude, p.latitude]),
        },
        properties: {
          distance_km: Math.round(totalDistanceKm(hist24) * 100) / 100,
          point_count: hist24.length,
        },
      },
      search_suggestion: {
        radius_m:   500,
        direction:  last?.heading !== undefined ? headingToCompass(last.heading) : 'Unknown',
        last_speed: last?.speed,
      },
    });
  } catch (e) { err(res, e.message, 500); }
});

function headingToCompass(deg) {
  const dirs = ['N','NE','E','SE','S','SW','W','NW','N'];
  return dirs[Math.round(deg / 45) % 8];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 26 — Behaviour Anomaly (Isolation Forest approximation)
// GET /api/v1/analytics/behaviour-anomaly/:animalId
//
// Features: distance, speed, grazing, social (from API 18), historical avg.
// Uses statistical Z-score method as a server-side surrogate for
// Isolation Forest / Autoencoder (no ML runtime deployed here).
// Integrate with Python ML microservice via HTTP if needed.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/behaviour-anomaly/:animalId', async (req, res) => {
  try {
    const imei   = await resolveImei(req.params.animalId);
    const date   = req.query.date || todayStr();
    const todayPts = await getDayHistory(imei, date);
    const hist     = await getNDayHistory(imei, 30);

    const todayDist    = totalDistanceKm(todayPts);
    const todayGrazing = grazingHours(todayPts);
    const todaySpeeds  = todayPts.map(p => p.speed || 0);
    const todayAvgSpd  = todaySpeeds.reduce((a, b) => a + b, 0) / (todaySpeeds.length || 1);

    // Build 30-day daily feature vectors
    const dayMap = {};
    hist.forEach(p => {
      const d = new Date(p.timestamp).toISOString().slice(0, 10);
      if (!dayMap[d]) dayMap[d] = [];
      dayMap[d].push(p);
    });

    const histDists    = Object.values(dayMap).map(pts => totalDistanceKm(pts));
    const histGrazing  = Object.values(dayMap).map(pts => grazingHours(pts));
    const histSpeeds   = Object.values(dayMap).map(pts => {
      const sp = pts.map(p => p.speed || 0);
      return sp.reduce((a, b) => a + b, 0) / (sp.length || 1);
    });

    const zDist    = zScore(todayDist,    histDists);
    const zGrazing = zScore(todayGrazing, histGrazing);
    const zSpeed   = zScore(todayAvgSpd,  histSpeeds);

    // Anomaly score = weighted magnitude of Z-scores, normalised to 0–100
    const anomalyRaw = (Math.abs(zDist) * 0.4 + Math.abs(zGrazing) * 0.35 + Math.abs(zSpeed) * 0.25);
    const anomaly_score = clamp100(anomalyRaw * 25);  // Z>4 = score ~100

    ok(res, {
      animal_id:     req.params.animalId,
      date,
      anomaly_score,
      is_anomalous:  anomaly_score > 70,
      features: {
        today_distance_km:  Math.round(todayDist    * 100) / 100,
        today_grazing_hrs:  Math.round(todayGrazing * 100) / 100,
        today_avg_speed:    Math.round(todayAvgSpd  * 100) / 100,
        z_score_distance:   Math.round(zDist    * 100) / 100,
        z_score_grazing:    Math.round(zGrazing * 100) / 100,
        z_score_speed:      Math.round(zSpeed   * 100) / 100,
      },
      model_note: 'Statistical Z-score method. Connect /api/v1/analytics/ml-anomaly/:animalId for Isolation Forest / Autoencoder via Python microservice.',
    });
  } catch (e) { err(res, e.message, 500); }
});

function zScore(value, population) {
  if (population.length < 2) return 0;
  const mean = population.reduce((a, b) => a + b, 0) / population.length;
  const std  = Math.sqrt(population.reduce((a, b) => a + (b - mean) ** 2, 0) / population.length);
  return std > 0 ? (value - mean) / std : 0;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 27 — Welfare Score
// GET /api/v1/analytics/welfare-score/:animalId?date=YYYY-MM-DD
//
// 25% Activity + 25% Grazing + 20% Social + 15% Water Visits + 15% Consistency
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/welfare-score/:animalId', async (req, res) => {
  try {
    const imei   = await resolveImei(req.params.animalId);
    const date   = req.query.date || todayStr();
    const pts    = await getDayHistory(imei, date);

    const todayActive  = activeHours(pts);
    const hist7 = await getNDayHistory(imei, 7);
    const dayMap = {};
    hist7.forEach(p => {
      const d = new Date(p.timestamp).toISOString().slice(0, 10);
      if (!dayMap[d]) dayMap[d] = [];
      dayMap[d].push(p);
    });
    const avgActive  = Object.values(dayMap).reduce((s, dp) => s + activeHours(dp), 0) /
                       (Object.keys(dayMap).length || 1);
    const activityScore = avgActive > 0 ? clamp100((todayActive / avgActive) * 100) : 50;

    const todayGrazing  = grazingHours(pts);
    const avgGrazing    = Object.values(dayMap).reduce((s, dp) => s + grazingHours(dp), 0) /
                          (Object.keys(dayMap).length || 1);
    const grazingScore  = avgGrazing > 0 ? clamp100((todayGrazing / avgGrazing) * 100) : 50;

    // Water visits (simple count today)
    const waterPts  = await WaterPoint.find({ active: true }).lean();
    const waterVisits = waterPts.length
      ? detectVisits(pts, waterPts, WATER_DIST_M).length : 0;
    const waterScore = clamp100(waterVisits * 25);   // 4+ visits = 100

    // Consistency: low variance in daily distance = good consistency
    const dailyDists = Object.values(dayMap).map(dp => totalDistanceKm(dp));
    const meanDist = dailyDists.reduce((a, b) => a + b, 0) / (dailyDists.length || 1);
    const cv = meanDist > 0
      ? Math.sqrt(dailyDists.reduce((a, b) => a + (b - meanDist) ** 2, 0) / dailyDists.length) / meanDist
      : 0;
    const consistencyScore = clamp100((1 - Math.min(cv, 1)) * 100);

    // Social score placeholder (full calc is expensive in this endpoint)
    const socialScore = 70;  // recommend calling /social-score/:animalId for full value

    const welfare_score = clamp100(
      activityScore    * 0.25 +
      grazingScore     * 0.25 +
      socialScore      * 0.20 +
      waterScore       * 0.15 +
      consistencyScore * 0.15
    );

    ok(res, {
      animal_id:     req.params.animalId,
      date,
      welfare_score,
      status: welfare_score >= 75 ? 'Good' : welfare_score >= 50 ? 'Fair' : 'Poor',
      components: {
        activity:    Math.round(activityScore),
        grazing:     Math.round(grazingScore),
        social:      socialScore,
        water_visits:Math.round(waterScore),
        consistency: Math.round(consistencyScore),
      },
    });
  } catch (e) { err(res, e.message, 500); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 28 — Productivity Score
// GET /api/v1/analytics/productivity-score/:animalId?date=YYYY-MM-DD
//
// Activity + Grazing Time + Pasture Utilisation + Historical Performance → 0–100
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/productivity-score/:animalId', async (req, res) => {
  try {
    const imei  = await resolveImei(req.params.animalId);
    const date  = req.query.date || todayStr();
    const pts   = await getDayHistory(imei, date);
    const hist  = await getNDayHistory(imei, 30);

    const todayActive  = activeHours(pts);
    const todayGrazing = grazingHours(pts);
    const todayDist    = totalDistanceKm(pts);

    const dayMap = {};
    hist.forEach(p => {
      const d = new Date(p.timestamp).toISOString().slice(0, 10);
      if (!dayMap[d]) dayMap[d] = [];
      dayMap[d].push(p);
    });

    const avgDist    = Object.values(dayMap).reduce((s, dp) => s + totalDistanceKm(dp), 0) / (Object.keys(dayMap).length || 1);
    const avgGrazing = Object.values(dayMap).reduce((s, dp) => s + grazingHours(dp), 0)    / (Object.keys(dayMap).length || 1);
    const avgActive  = Object.values(dayMap).reduce((s, dp) => s + activeHours(dp), 0)      / (Object.keys(dayMap).length || 1);

    // Pasture utilisation: unique grid cells visited today / last 7 days
    // grazingZoneMap imported at top of file
    const todayZones = Object.keys(grazingZoneMap(pts)).length;
    const hist7pts   = await getNDayHistory(imei, 7);
    const hist7Zones = Object.keys(grazingZoneMap(hist7pts)).length || 1;
    const pastureUtil = clamp100(todayZones / hist7Zones * 100);

    const activityScore   = avgActive  > 0 ? clamp100(todayActive  / avgActive  * 100) : 50;
    const grazingScr      = avgGrazing > 0 ? clamp100(todayGrazing / avgGrazing * 100) : 50;
    const histPerf        = avgDist    > 0 ? clamp100(todayDist    / avgDist    * 100) : 50;

    const productivity_score = clamp100(
      activityScore * 0.30 +
      grazingScr    * 0.30 +
      pastureUtil   * 0.20 +
      histPerf      * 0.20
    );

    ok(res, {
      animal_id:          req.params.animalId,
      date,
      productivity_score,
      status: productivity_score >= 75 ? 'High' : productivity_score >= 50 ? 'Medium' : 'Low',
      components: {
        activity:            Math.round(activityScore),
        grazing:             Math.round(grazingScr),
        pasture_utilisation: Math.round(pastureUtil),
        historical_perf:     Math.round(histPerf),
      },
    });
  } catch (e) { err(res, e.message, 500); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 29 — Disease Prediction
// GET /api/v1/analytics/disease-risk/:animalId?date=YYYY-MM-DD
//
// Early indicators: reduced movement, reduced grazing, isolation,
// reduced water visits, activity decline.
// Uses weighted scoring as surrogate for Random Forest / XGBoost.
// Connect Python ML microservice at /api/v1/analytics/ml-disease for full model.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/disease-risk/:animalId', async (req, res) => {
  try {
    const imei  = await resolveImei(req.params.animalId);
    const date  = req.query.date || todayStr();
    const pts   = await getDayHistory(imei, date);
    const hist7 = await getNDayHistory(imei, 7);

    const dayMap = {};
    hist7.forEach(p => {
      const d = new Date(p.timestamp).toISOString().slice(0, 10);
      if (!dayMap[d]) dayMap[d] = [];
      dayMap[d].push(p);
    });

    const avgActive  = Object.values(dayMap).reduce((s, dp) => s + activeHours(dp), 0) / (Object.keys(dayMap).length || 1);
    const avgGrazing = Object.values(dayMap).reduce((s, dp) => s + grazingHours(dp), 0) / (Object.keys(dayMap).length || 1);

    const todayActive  = activeHours(pts);
    const todayGrazing = grazingHours(pts);

    const activityDrop  = avgActive  > 0 ? Math.max(0, 1 - todayActive  / avgActive)  : 0;
    const grazingDrop   = avgGrazing > 0 ? Math.max(0, 1 - todayGrazing / avgGrazing) : 0;

    const tag = await CattleTag.findOne({ imei }).lean();
    const isolated  = tag?.alarms?.perimeterBreach ? 0 : 0;
    const isolScore = (tag?.behaviourState === 'SLEEPING' && todayActive < avgActive * 0.4) ? 0.7 : 0;

    const waterPts = await WaterPoint.find({ active: true }).lean();
    const waterToday = detectVisits(pts, waterPts, WATER_DIST_M).length;
    const waterDropScore = waterToday === 0 && avgActive > 4 ? 0.8 : 0;

    const disease_risk = clamp100(
      activityDrop   * 35 +
      grazingDrop    * 25 +
      isolScore      * 20 +
      waterDropScore * 20
    );

    const indicators = [];
    if (activityDrop > 0.3)   indicators.push('Reduced movement');
    if (grazingDrop  > 0.3)   indicators.push('Reduced grazing');
    if (isolScore    > 0.5)   indicators.push('Isolation pattern');
    if (waterDropScore > 0.5) indicators.push('Reduced water intake');

    ok(res, {
      animal_id:   req.params.animalId,
      date,
      disease_risk,
      risk_level: disease_risk >= 70 ? 'High' : disease_risk >= 40 ? 'Medium' : 'Low',
      indicators,
      features: {
        activity_drop_pct: Math.round(activityDrop * 100),
        grazing_drop_pct:  Math.round(grazingDrop  * 100),
        water_visits:      waterToday,
        isolation_score:   Math.round(isolScore * 100),
      },
      model_note: 'Weighted heuristic model. Connect /api/v1/analytics/ml-disease/:animalId for Random Forest / XGBoost via Python microservice.',
    });
  } catch (e) { err(res, e.message, 500); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 30 — Livestock Risk Score (Insurance)
// GET /api/v1/analytics/insurance-risk/:animalId
//
// 30% Health + 25% Theft + 20% Geofence + 15% Activity + 10% Historical
// Premium bands: Low <40, Medium 40–69, High ≥70
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/insurance-risk/:animalId', async (req, res) => {
  try {
    const imei   = await resolveImei(req.params.animalId);
    const date   = req.query.date || todayStr();

    const pts      = await getDayHistory(imei, date);
    const hist30   = await getNDayHistory(imei, 30);
    const hist7    = await getNDayHistory(imei, 7);

    // Health component (activity drop vs 7-day)
    const dayMap7 = {};
    hist7.forEach(p => {
      const d = new Date(p.timestamp).toISOString().slice(0, 10);
      if (!dayMap7[d]) dayMap7[d] = [];
      dayMap7[d].push(p);
    });
    const avgActive7 = Object.values(dayMap7).reduce((s, dp) => s + activeHours(dp), 0) / (Object.keys(dayMap7).length || 1);
    const todayActive = activeHours(pts);
    const healthScore = avgActive7 > 0 ? clamp100((1 - todayActive / avgActive7) * 100) : 0;

    // Theft component (night movement + geofence breach)
    const nightMoves = hist30.filter(p => isNightHour(p.timestamp) && (p.speed || 0) > 2).length;
    const theftScore = clamp100(nightMoves / 5 * 100);

    // Geofence component
    const geoBreaches = await AlarmEvent.countDocuments({
      imei, type: 'PERIMETER_BREACH',
      timestamp: { $gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) },
    });
    const geoScore = clamp100(geoBreaches * 10);

    // Activity irregularity
    const dayMap30 = {};
    hist30.forEach(p => {
      const d = new Date(p.timestamp).toISOString().slice(0, 10);
      if (!dayMap30[d]) dayMap30[d] = [];
      dayMap30[d].push(p);
    });
    const dists30    = Object.values(dayMap30).map(dp => totalDistanceKm(dp));
    const meanDist   = dists30.reduce((a, b) => a + b, 0) / (dists30.length || 1);
    const cvDist     = meanDist > 0
      ? Math.sqrt(dists30.reduce((a, b) => a + (b - meanDist) ** 2, 0) / dists30.length) / meanDist : 0;
    const activityRiskScore = clamp100(cvDist * 100);

    // Historical incidents
    const incidentCount = await AlarmEvent.countDocuments({ imei });
    const historicalScore = clamp100(incidentCount * 5);

    const risk_score = clamp100(
      healthScore       * 0.30 +
      theftScore        * 0.25 +
      geoScore          * 0.20 +
      activityRiskScore * 0.15 +
      historicalScore   * 0.10
    );

    const premium_band = risk_score < 40 ? 'Low' : risk_score < 70 ? 'Medium' : 'High';

    ok(res, {
      animal_id:    req.params.animalId,
      risk_score,
      premium_band,
      components: {
        health_risk:           Math.round(healthScore       * 0.30),
        theft_risk:            Math.round(theftScore        * 0.25),
        geofence_risk:         Math.round(geoScore          * 0.20),
        activity_irregularity: Math.round(activityRiskScore * 0.15),
        historical_incidents:  Math.round(historicalScore   * 0.10),
      },
      raw: {
        geofence_breaches_30d: geoBreaches,
        incident_count:        incidentCount,
        night_movements_30d:   nightMoves,
      },
    });
  } catch (e) { err(res, e.message, 500); }
});

// Lightweight visit detector (no dt tracking — just entry events)
function detectVisits(pts, locations, radiusM) {
  const visits = [];
  for (const loc of locations) {
    let inZone = false;
    for (const pt of pts) {
      const dist = haversineM(pt.latitude, pt.longitude, loc.latitude, loc.longitude);
      if (dist < radiusM && !inZone)  { inZone = true; visits.push({ loc: loc.name, ts: pt.timestamp }); }
      if (dist >= radiusM && inZone)    inZone = false;
    }
  }
  return visits;
}

module.exports = router;
