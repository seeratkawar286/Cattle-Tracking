'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * CattleTag
 * One document per physical HCS048 collar/device.
 * Acts as the "current state" record — last known position, battery,
 * connectivity, and derived status — for quick dashboard lookups.
 *
 * NOTE: linking a device's IMEI to a specific animal's identity/name is
 * not something the device protocol provides — that mapping has to be
 * assigned manually (e.g. when a collar is fitted to a cow). `animalId`
 * is left optional and unindexed-unique for now so a collar can exist
 * in the system before it's been assigned to an animal.
 */
const CattleTagSchema = new Schema(
  {
    imei: { type: String, required: true, unique: true, index: true },
    animalId: { type: String, default: null }, // assign later via your own UI/process
    animalName: { type: String, default: null },

    lastKnownLocation: {
      latitude: { type: Number, default: null },
      longitude: { type: Number, default: null },
      speed: { type: Number, default: null },
      heading: { type: Number, default: null },
      altitude: { type: Number, default: null },
      positioned: { type: Boolean, default: null },
      source: { type: String, enum: ['gps', 'lbs', 'wifi', null], default: null },
      timestamp: { type: Date, default: null },
    },

    lastBattery: { type: Number, default: null }, // percent
    lastSignal: { type: Number, default: null }, // gsm signal 0-100

    // Power-saving mode currently configured on the device (per SAVE command):
    // 0 = real-time online, 1 = all-day power saving, 2 = night-only power saving.
    // Needed to correctly distinguish "asleep" from "offline" — see notes
    // from earlier debugging conversation on this exact ambiguity.
    saveMode: { type: Number, enum: [0, 1, 2], default: 0 },

    lastSeenAt: { type: Date, default: null }, // last time ANY packet was received
    lastVibrationAt: { type: Date, default: null }, // last time vibration bit was set

    status: {
      type: String,
      enum: ['active', 'resting', 'sleeping', 'offline', 'low_battery', 'unknown'],
      default: 'unknown',
    },

    deviceModel: { type: String, default: null }, // ITEM from INFO packet
    firmwareVersion: { type: String, default: null }, // VER from INFO packet
  },
  { timestamps: true }
);

/**
 * LocationHistory
 * One document per GPS/LBS/WIFI fix received — the time-series trail used
 * for grazing-path reconstruction, geofencing checks, and movement analysis.
 */
const LocationHistorySchema = new Schema(
  {
    imei: { type: String, required: true, index: true },
    timestamp: { type: Date, required: true, default: Date.now, index: true },

    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    speed: { type: Number, default: null },
    heading: { type: Number, default: null },
    altitude: { type: Number, default: null },
    satellites: { type: Number, default: null },
    positioned: { type: Boolean, default: null },
    source: { type: String, enum: ['gps', 'lbs', 'wifi', 'unknown'], default: 'unknown' },

    raw: { type: String, default: null }, // original frame, kept for debugging/audit
  },
  { timestamps: true }
);

/**
 * AlarmEvent
 * One document per alarm trigger (vibration on/off transition, low power,
 * or SOS) decoded from the ALERT bitmask.
 */
const AlarmEventSchema = new Schema(
  {
    imei: { type: String, required: true, index: true },
    timestamp: { type: Date, required: true, default: Date.now, index: true },
    type: { type: String, enum: ['vibration', 'lowPower', 'sos'], required: true },
    resolved: { type: Boolean, default: false },
    resolvedAt: { type: Date, default: null },
    notes: { type: String, default: null },
  },
  { timestamps: true }
);

// Avoid "OverwriteModelError" if this file is required more than once in
// the same process (common with hot-reload/dev servers).
const CattleTag = mongoose.models.CattleTag || mongoose.model('CattleTag', CattleTagSchema);
const LocationHistory =
  mongoose.models.LocationHistory || mongoose.model('LocationHistory', LocationHistorySchema);
const AlarmEvent = mongoose.models.AlarmEvent || mongoose.model('AlarmEvent', AlarmEventSchema);

module.exports = { CattleTag, LocationHistory, AlarmEvent };
