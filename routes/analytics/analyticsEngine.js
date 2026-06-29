'use strict';

const { LocationHistory, AlarmEvent } = require('../../models/CattleTag');

/**
 * analyticsEngine
 *
 * Real computed metrics derived from LocationHistory and AlarmEvent
 * records already being saved by the TCP socket server. No raw
 * accelerometer data is available from the HCS048 hardware (confirmed
 * by the vendor) — `accelerationEvents` uses the vibration ALERT bit
 * as the closest available proxy, exactly as discussed when designing
 * the parser.
 *
 * Two functions — grazingZoneMap and herdAverages — need pasture/zone
 * definitions that haven't been designed yet (see PastureRotation model).
 * They return a real, well-formed "not yet configured" result rather
 * than fake numbers, and are ready to wire up once zones are defined.
 */

const EARTH_RADIUS_KM = 6371;

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const rLat1 = toRadians(lat1);
  const rLat2 = toRadians(lat2);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

function clamp100(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function startOfDay(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date) {
  const d = new Date(date);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

/**
 * Fetches all LocationHistory records for one animal on one calendar day,
 * sorted oldest -> newest.
 */
async function getDayHistory(imei, date = new Date()) {
  return LocationHistory.find({
    imei,
    timestamp: { $gte: startOfDay(date), $lte: endOfDay(date) },
  })
    .sort({ timestamp: 1 })
    .lean();
}

/**
 * Fetches all LocationHistory records for one animal over the last N days
 * (inclusive of today), sorted oldest -> newest.
 */
async function getNDayHistory(imei, days = 7) {
  const from = startOfDay(new Date());
  from.setUTCDate(from.getUTCDate() - (days - 1));
  return LocationHistory.find({
    imei,
    timestamp: { $gte: from },
  })
    .sort({ timestamp: 1 })
    .lean();
}

/**
 * Total distance travelled across a set of (already time-sorted) location
 * records, in kilometers — sum of consecutive-point Haversine distances.
 * Records with no valid fix (positioned === false, or missing lat/lng) are
 * skipped rather than counted as a "jump" to/from 0,0.
 */
function totalDistanceKm(records = []) {
  let total = 0;
  let prev = null;
  for (const r of records) {
    if (r.latitude === null || r.longitude === null || r.positioned === false) continue;
    if (prev) {
      total += haversineKm(prev.latitude, prev.longitude, r.latitude, r.longitude);
    }
    prev = r;
  }
  return Math.round(total * 1000) / 1000; // 3 decimal places
}

/**
 * Coefficient of variation of speed (stddev / mean) across records that
 * have a valid speed reading. Higher = more erratic movement, which can
 * be a useful flag alongside other signals (e.g. potential estrus
 * behaviour), though it isn't a diagnosis on its own.
 */
function speedVariabilityIndex(records = []) {
  const speeds = records.map((r) => r.speed).filter((s) => typeof s === 'number' && s >= 0);
  if (speeds.length < 2) return 0;
  const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
  if (mean === 0) return 0;
  const variance = speeds.reduce((sum, s) => sum + (s - mean) ** 2, 0) / speeds.length;
  const stddev = Math.sqrt(variance);
  return Math.round((stddev / mean) * 1000) / 1000;
}

/**
 * Estimated hours the animal was "active" (speed above a small moving
 * threshold), approximated from the time gap between consecutive samples
 * that meet the threshold.
 */
function activeHours(records = [], speedThresholdKmh = 0.5) {
  let hours = 0;
  for (let i = 1; i < records.length; i++) {
    const prev = records[i - 1];
    const curr = records[i];
    if (typeof curr.speed !== 'number' || curr.speed < speedThresholdKmh) continue;
    const gapMs = new Date(curr.timestamp) - new Date(prev.timestamp);
    if (gapMs > 0 && gapMs < 1000 * 60 * 60 * 6) {
      // ignore absurd gaps (e.g. device offline for hours) so a single
      // reconnection doesn't get counted as 6 hours of activity
      hours += gapMs / (1000 * 60 * 60);
    }
  }
  return Math.round(hours * 100) / 100;
}

/**
 * Estimated grazing hours — speed in a typical grazing range (slow,
 * deliberate movement), distinct from standing still (0) and from
 * faster travelling/running. Range is a starting assumption and should
 * be tuned once real grazing-speed data is available.
 */
function grazingHours(records = [], minKmh = 0.3, maxKmh = 3) {
  let hours = 0;
  for (let i = 1; i < records.length; i++) {
    const prev = records[i - 1];
    const curr = records[i];
    if (typeof curr.speed !== 'number' || curr.speed < minKmh || curr.speed > maxKmh) continue;
    const gapMs = new Date(curr.timestamp) - new Date(prev.timestamp);
    if (gapMs > 0 && gapMs < 1000 * 60 * 60 * 6) {
      hours += gapMs / (1000 * 60 * 60);
    }
  }
  return Math.round(hours * 100) / 100;
}

/**
 * Count of records where the animal was moving at all (speed > 0).
 * A coarse activity counter, simpler than activeHours.
 */
function movementCount(records = []) {
  return records.filter((r) => typeof r.speed === 'number' && r.speed > 0).length;
}

/**
 * Classifies overall movement level for a set of records into a simple
 * label. Thresholds are starting points — adjust once you have a
 * baseline of normal vs. abnormal for your herd.
 */
function movementPattern(records = []) {
  const distance = totalDistanceKm(records);
  if (records.length === 0) return 'unknown';
  if (distance < 0.5) return 'sedentary';
  if (distance < 3) return 'moderate';
  return 'active';
}

/**
 * Proxy for "acceleration events" using vibration ALERT triggers, since
 * the HCS048 does not expose raw accelerometer data (vendor-confirmed —
 * see hcs048Parser.js notes). Counts vibration alarm events for this
 * animal within the given time range.
 */
async function accelerationEvents(imei, from, to) {
  return AlarmEvent.countDocuments({
    imei,
    type: 'vibration',
    timestamp: { $gte: from, $lte: to },
  });
}

/**
 * Average daily distance over the last 7 entries in a series of
 * { date, totalDistanceKm } daily summaries (e.g. from DailyAnalytics).
 */
function sevenDayAvgDistance(dailySummaries = []) {
  const last7 = dailySummaries.slice(-7);
  if (last7.length === 0) return 0;
  const sum = last7.reduce((acc, d) => acc + (d.totalDistanceKm || 0), 0);
  return Math.round((sum / last7.length) * 1000) / 1000;
}

/**
 * Average daily active hours over the last N entries in a series of
 * { date, activeHours } daily summaries.
 */
function nDayAvgActivity(dailySummaries = [], n = 7) {
  const lastN = dailySummaries.slice(-n);
  if (lastN.length === 0) return 0;
  const sum = lastN.reduce((acc, d) => acc + (d.activeHours || 0), 0);
  return Math.round((sum / lastN.length) * 100) / 100;
}

/**
 * NOT YET CONFIGURABLE: requires named pasture/zone boundaries, which
 * haven't been designed yet (see models/Analytics.js PastureRotation).
 * Returns a real, well-formed "not configured" result instead of fake
 * data. Once pastures are defined, this should look up PastureRotation
 * documents and bucket each location record into whichever zone it falls
 * inside (reusing the same Haversine-distance approach as
 * services/geofenceService.js).
 */
async function grazingZoneMap(imei, records = []) {
  return {
    configured: false,
    imei,
    zones: [],
    notes: ['No pasture/zone boundaries defined yet — see PastureRotation model'],
  };
}

/**
 * NOT YET CONFIGURABLE: averaging "across the herd" requires knowing
 * which animals belong to the same herd/group, which isn't modeled yet.
 * Returns a real, well-formed "not configured" result instead of a
 * fabricated average.
 */
async function herdAverages(imeis = []) {
  return {
    configured: false,
    animalCount: imeis.length,
    notes: ['Herd/group membership is not yet modeled — see CattleTag for individual data instead'],
  };
}

module.exports = {
  getDayHistory,
  getNDayHistory,
  totalDistanceKm,
  speedVariabilityIndex,
  activeHours,
  movementCount,
  movementPattern,
  grazingHours,
  grazingZoneMap,
  herdAverages,
  sevenDayAvgDistance,
  nDayAvgActivity,
  accelerationEvents,
  clamp100,
};
