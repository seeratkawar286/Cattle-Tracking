'use strict';

/**
 * geofenceService
 *
 * Checks whether a given lat/lng for a device (imei) has breached its
 * configured geofence boundary.
 *
 * Current design: a single farm-wide circular geofence (center point +
 * radius), configured via environment variables. This is intentionally
 * simple because per-animal/per-pasture boundaries haven't been designed
 * yet — see the "Extending this later" notes at the bottom.
 *
 * Env vars (all optional — if any are missing, breach checking is
 * effectively disabled and checkBreach() always returns false rather
 * than throwing or guessing):
 *   GEOFENCE_CENTER_LAT     - latitude of the farm/pasture center point
 *   GEOFENCE_CENTER_LNG     - longitude of the farm/pasture center point
 *   GEOFENCE_RADIUS_METERS  - allowed radius from center, in meters
 */

const EARTH_RADIUS_METERS = 6371000;

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

/**
 * Great-circle distance between two lat/lng points, in meters.
 * Standard Haversine formula.
 */
function haversineDistanceMeters(lat1, lng1, lat2, lng2) {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const rLat1 = toRadians(lat1);
  const rLat2 = toRadians(lat2);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_METERS * c;
}

function getConfiguredGeofence() {
  const lat = parseFloat(process.env.GEOFENCE_CENTER_LAT);
  const lng = parseFloat(process.env.GEOFENCE_CENTER_LNG);
  const radius = parseFloat(process.env.GEOFENCE_RADIUS_METERS);

  if (Number.isNaN(lat) || Number.isNaN(lng) || Number.isNaN(radius)) {
    return null; // not configured yet
  }
  return { lat, lng, radius };
}

/**
 * Checks whether (latitude, longitude) is outside the configured geofence.
 *
 * @param {string} imei - device identifier (not yet used to look up a
 *   per-device boundary, but kept in the signature so per-animal geofences
 *   can be added later without changing every call site)
 * @param {number} latitude
 * @param {number} longitude
 * @returns {Promise<boolean>} true if outside the geofence (breach),
 *   false if inside, or false if no geofence is configured yet
 */
async function checkBreach(imei, latitude, longitude) {
  if (latitude === null || longitude === null || latitude === undefined || longitude === undefined) {
    return false;
  }

  const geofence = getConfiguredGeofence();
  if (!geofence) {
    // No boundary configured yet — nothing to breach against.
    // (Intentionally silent/no-op rather than throwing, so the app keeps
    // running while pasture boundaries are still being decided.)
    return false;
  }

  const distance = haversineDistanceMeters(geofence.lat, geofence.lng, latitude, longitude);
  return distance > geofence.radius;
}

module.exports = {
  checkBreach,
  // exported for testing/debugging and future per-device geofences
  _internal: { haversineDistanceMeters, getConfiguredGeofence },
};

/**
 * Extending this later, once pasture boundaries are decided:
 *
 * 1. Per-animal/per-pasture boundaries:
 *    Add a `geofence: { centerLat, centerLng, radiusMeters }` field to the
 *    CattleTag model (or a separate Geofence/Pasture model if boundaries
 *    are shared across many animals), then change checkBreach() to look
 *    that up by `imei` instead of reading from env vars.
 *
 * 2. Polygon boundaries instead of a circle:
 *    If pastures aren't roughly circular, swap the Haversine radius check
 *    for a point-in-polygon test (e.g. using the `point-in-polygon` npm
 *    package) against a stored list of boundary coordinates.
 *
 * 3. Persisting breach state:
 *    Right now this only returns true/false for the current check. If you
 *    want a history of breach events (e.g. for the AlarmEvent model),
 *    write one when checkBreach() flips from false -> true.
 */
