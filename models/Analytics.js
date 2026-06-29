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

const DailyAnalytics =
  mongoose.models.DailyAnalytics || mongoose.model('DailyAnalytics', DailyAnalyticsSchema);
const PastureRotation =
  mongoose.models.PastureRotation || mongoose.model('PastureRotation', PastureRotationSchema);

module.exports = { DailyAnalytics, PastureRotation };
