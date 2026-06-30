'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * DailyAnalytics
 * One document per animal per calendar day — a precomputed summary so
 * dashboards don't have to recompute from raw LocationHistory every time.
 */
const DailyAnalyticsSchema = new Schema(
  {
    imei: { type: String, required: true, index: true },
    date: { type: String, required: true, index: true }, // 'YYYY-MM-DD', simple and sortable

    totalDistanceKm: { type: Number, default: 0 },
    activeHours: { type: Number, default: 0 },
    grazingHours: { type: Number, default: 0 },
    restingHours: { type: Number, default: 0 },
    movementCount: { type: Number, default: 0 },
    speedVariabilityIndex: { type: Number, default: 0 },
    accelerationEvents: { type: Number, default: 0 }, // proxy via vibration alarms, no raw accelerometer available
    movementPattern: {
      type: String,
      enum: ['sedentary', 'moderate', 'active', 'unknown'],
      default: 'unknown',
    },
  },
  { timestamps: true }
);
DailyAnalyticsSchema.index({ imei: 1, date: 1 }, { unique: true });

/**
 * PastureRotation
 * Defines a named pasture/zone an animal (or herd) can be assigned to.
 * Boundary definition is left minimal (circular, like geofenceService)
 * since exact zone shapes haven't been designed yet — extend this with
 * a polygon field later if pastures aren't roughly circular.
 */
const PastureRotationSchema = new Schema(
  {
    name: { type: String, required: true },
    centerLat: { type: Number, default: null },
    centerLng: { type: Number, default: null },
    radiusMeters: { type: Number, default: null },

    assignedImeis: [{ type: String }], // animals currently assigned to this pasture
    activeFrom: { type: Date, default: null },
    activeTo: { type: Date, default: null }, // null = still active
  },
  { timestamps: true }
);

/**
 * WaterPoint
 * A named water-source location. Used with WATER_DIST_M / haversineM in
 * analyticsEngine.js to check whether an animal's location is near a
 * known water source.
 */
const WaterPointSchema = new Schema(
  {
    name: { type: String, required: true },
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

/**
 * FeedZone
 * A named feeding-area location/boundary, same circular-zone approach
 * as Geofence/PastureRotation.
 */
const FeedZoneSchema = new Schema(
  {
    name: { type: String, required: true },
    centerLat: { type: Number, required: true },
    centerLng: { type: Number, required: true },
    radiusMeters: { type: Number, default: 50 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

/**
 * HeatEvent
 * Records a possible estrus/heat-behaviour flag for an animal. This is a
 * DERIVED signal, not a direct device reading — the HCS048 has no
 * estrus-detection capability. It should only be written by logic that
 * combines available signals (e.g. elevated speedVariabilityIndex,
 * increased movementCount, time-of-day) as a soft flag for a human to
 * review, not an automatic diagnosis.
 */
const HeatEventSchema = new Schema(
  {
    imei: { type: String, required: true, index: true },
    timestamp: { type: Date, required: true, default: Date.now, index: true },
    confidence: { type: Number, min: 0, max: 100, default: 0 }, // 0-100, see clamp100()
    basis: { type: String, default: null }, // free-text note on what signals triggered this
    reviewed: { type: Boolean, default: false },
    confirmed: { type: Boolean, default: null }, // null = not yet reviewed by a human
  },
  { timestamps: true }
);

const DailyAnalytics =
  mongoose.models.DailyAnalytics || mongoose.model('DailyAnalytics', DailyAnalyticsSchema);
const PastureRotation =
  mongoose.models.PastureRotation || mongoose.model('PastureRotation', PastureRotationSchema);
const WaterPoint = mongoose.models.WaterPoint || mongoose.model('WaterPoint', WaterPointSchema);
const FeedZone = mongoose.models.FeedZone || mongoose.model('FeedZone', FeedZoneSchema);
const HeatEvent = mongoose.models.HeatEvent || mongoose.model('HeatEvent', HeatEventSchema);

module.exports = { DailyAnalytics, PastureRotation, WaterPoint, FeedZone, HeatEvent };
