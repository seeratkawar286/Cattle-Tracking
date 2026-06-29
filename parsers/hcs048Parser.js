'use strict';

/**
 * HCS048 TCP/IP Protocol Parser
 *
 * Frame format: ID#IMEI#SerialNumber#Length#Content$
 * Content format: Keyword:value1,value2,...;Keyword:value1,value2,...
 *
 * Exports:
 *   parseFrame(rawFrame)   -> structured JS object describing the packet
 *   inferBehaviour(parsed) -> derived cattle-monitoring signals from a parsed frame
 *   buildAck(parsed)       -> the correct downlink ACK string/Buffer to send back
 */

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

function hexToInt(hex) {
  if (hex === undefined || hex === null || hex === '') return null;
  const n = parseInt(hex, 16);
  return Number.isNaN(n) ? null : n;
}

function toNum(val) {
  if (val === undefined || val === null || val === '') return null;
  const n = Number(val);
  return Number.isNaN(n) ? null : n;
}

// GPS time comes as yymmddhhmmss (or yyyymmddhhmmss in some examples).
// Normalise to an ISO-ish string without guessing century incorrectly.
function parseGpsTime(raw) {
  if (!raw) return null;
  let s = String(raw);
  let yy, mm, dd, hh, mi, ss;
  if (s.length === 12) {
    // yymmddhhmmss
    yy = '20' + s.slice(0, 2);
    mm = s.slice(2, 4);
    dd = s.slice(4, 6);
    hh = s.slice(6, 8);
    mi = s.slice(8, 10);
    ss = s.slice(10, 12);
  } else if (s.length === 13 || s.length === 14) {
    // tolerate odd lengths seen in protocol examples (leading digit variance)
    s = s.slice(-12);
    return parseGpsTime(s);
  } else {
    return null;
  }
  return `${yy}-${mm}-${dd}T${hh}:${mi}:${ss}Z`;
}

// Parse "Keyword:value,value;Keyword:value,value" into a map of
// { KEYWORD: ['value','value'] }
function splitContent(content) {
  const sections = {};
  content
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((section) => {
      const idx = section.indexOf(':');
      if (idx === -1) return;
      const key = section.slice(0, idx).trim().toUpperCase();
      const valuePart = section.slice(idx + 1).trim();
      sections[key] = valuePart.split(',').map((v) => v.trim());
    });
  return sections;
}

// ---------------------------------------------------------------------------
// Section decoders
// ---------------------------------------------------------------------------

function decodeCell(values) {
  if (!values || values.length < 6) return null;
  const [numBaseStations, mcc, mnc, regionalCode, cellCode, signalStrength] = values;
  return {
    numberOfBaseStations: toNum(numBaseStations),
    mcc: hexToInt(mcc),
    mnc: hexToInt(mnc),
    regionalCode: hexToInt(regionalCode),
    cellCode: hexToInt(cellCode),
    signalStrength: hexToInt(signalStrength),
  };
}

function decodeGdata(values) {
  if (!values || values.length < 8) return null;
  const [positioned, satellites, gpsTime, lat, lng, speed, heading, altitude] = values;
  return {
    positioned: positioned === 'A',
    positionedRaw: positioned,
    satellites: toNum(satellites),
    gpsTime: parseGpsTime(gpsTime),
    gpsTimeRaw: gpsTime,
    latitude: toNum(lat),
    longitude: toNum(lng),
    speed: toNum(speed),
    heading: toNum(heading),
    altitude: toNum(altitude),
  };
}

function decodeAlert(values) {
  if (!values || values.length < 1) return null;
  const hex = values[0];
  const bitmask = hexToInt(hex) || 0;
  return {
    raw: hex,
    lowPower: Boolean(bitmask & 0x0001),
    sos: Boolean(bitmask & 0x0002),
    vibration: Boolean(bitmask & 0x0004),
  };
}

function decodeStatus(values) {
  if (!values || values.length < 2) return null;
  const [battery, signal] = values;
  return {
    battery: toNum(battery),
    signal: toNum(signal),
  };
}

function decodeWifi(values) {
  if (!values || values.length < 1) return null;
  const count = toNum(values[0]);
  const rest = values.slice(1);
  const accessPoints = [];
  // rest alternates: mac, rssi, mac, rssi, ...
  for (let i = 0; i < rest.length - 1; i += 2) {
    accessPoints.push({
      mac: rest[i],
      rssi: toNum(rest[i + 1]),
    });
  }
  return { count, accessPoints };
}

function decodeSync(values) {
  if (!values || values.length < 1) return null;
  return { counter: hexToInt(values[0]), counterRaw: values[0] };
}

function decodeLoca(values) {
  if (!values || values.length < 1) return null;
  const type = values[0];
  const map = { L: 'lbs', G: 'gps', W: 'wifi' };
  return { type, typeLabel: map[type] || 'unknown' };
}

function decodeInfo(values) {
  // INFO content layout per protocol device-parameters section:
  // ITEM, VER, PLMN, IMEI, IMSI, ICCID, OWNER, DEV (order can vary by firmware,
  // so we just keep both the raw array and best-guess named fields).
  if (!values) return null;
  const [item, ver, plmn, imei, imsi, iccid, owner, dev] = values;
  return { item, ver, plmn, imei, imsi, iccid, owner, dev, raw: values };
}

// ---------------------------------------------------------------------------
// parseFrame
// ---------------------------------------------------------------------------

/**
 * Parses one raw HCS048 frame (a single line/packet, with or without the
 * trailing '$' terminator) into a structured object.
 *
 * @param {string|Buffer} rawFrame
 * @returns {object|null} parsed frame, or null if the frame is malformed
 */
function parseFrame(rawFrame) {
  if (Buffer.isBuffer(rawFrame)) rawFrame = rawFrame.toString('utf8');
  if (typeof rawFrame !== 'string') return null;

  const frame = rawFrame.trim().replace(/\$+$/, '');
  if (!frame) return null;

  const parts = frame.split('#');
  if (parts.length < 5) return null;

  const [id, imei, serialNumberHex, lengthHex, ...contentParts] = parts;
  // Content itself may legitimately contain no further '#', but rejoin just
  // in case any value ever does.
  const content = contentParts.join('#');

  const sections = splitContent(content);

  const parsed = {
    id,
    imei,
    serialNumber: hexToInt(serialNumberHex),
    serialNumberRaw: serialNumberHex,
    length: hexToInt(lengthHex),
    raw: rawFrame,
    keywords: Object.keys(sections),
  };

  if (sections.SYNC) parsed.sync = decodeSync(sections.SYNC);
  if (sections.STATUS) parsed.status = decodeStatus(sections.STATUS);
  if (sections.LOCA) parsed.loca = decodeLoca(sections.LOCA);
  if (sections.CELL) parsed.cell = decodeCell(sections.CELL);
  if (sections.GDATA) parsed.gdata = decodeGdata(sections.GDATA);
  if (sections.ALERT) parsed.alert = decodeAlert(sections.ALERT);
  if (sections.WIFI) parsed.wifi = decodeWifi(sections.WIFI);
  if (sections.INFO) parsed.info = decodeInfo(sections.INFO);

  // Frame "type" — useful for routing logic downstream.
  if (sections.SYNC && !sections.LOCA) parsed.type = 'heartbeat';
  else if (sections.LOCA) parsed.type = 'position';
  else if (sections.INFO) parsed.type = 'info';
  else parsed.type = 'unknown';

  return parsed;
}

// ---------------------------------------------------------------------------
// inferBehaviour
// ---------------------------------------------------------------------------

/**
 * Derives cattle-monitoring-relevant signals from a parsed frame.
 * This does NOT have access to raw accelerometer data (the HCS048 doesn't
 * expose it) — it works only from the vibration bit, battery, and signal
 * fields actually available in the protocol.
 *
 * @param {object} parsed - output of parseFrame()
 * @returns {object} behaviour/derived signals
 */
function inferBehaviour(parsed) {
  if (!parsed) {
    return {
      motionDetected: null,
      activityState: 'unknown',
      lowBattery: null,
      sos: null,
      positionValid: null,
      notes: ['No parsed frame provided'],
    };
  }

  const notes = [];
  const vibration = parsed.alert ? parsed.alert.vibration : null;
  const lowPower = parsed.alert ? parsed.alert.lowPower : null;
  const sos = parsed.alert ? parsed.alert.sos : null;
  const positioned = parsed.gdata ? parsed.gdata.positioned : null;

  let activityState = 'unknown';
  if (vibration === true) activityState = 'active';
  else if (vibration === false) activityState = 'resting';
  else notes.push('No ALERT field present in this frame — activity state cannot be determined');

  if (positioned === false) {
    notes.push('GPS not positioned — location fields (if present) are the last known fix, not a live reading');
  }

  if (lowPower) notes.push('Low power alarm is set — device battery critically low');
  if (sos) notes.push('SOS alarm is set');

  return {
    motionDetected: vibration,
    activityState,
    lowBattery: lowPower,
    sos,
    positionValid: positioned,
    battery: parsed.status ? parsed.status.battery : null,
    signal: parsed.status ? parsed.status.signal : null,
    notes,
  };
}

// ---------------------------------------------------------------------------
// buildAck
// ---------------------------------------------------------------------------

function pad4Hex(num) {
  return (num & 0xffff).toString(16).padStart(4, '0');
}

function buildFrame(id, imei, serialNumberRaw, content) {
  const lengthHex = pad4Hex(content.length);
  return `${id}#${imei}#${serialNumberRaw}#${lengthHex}#${content}$`;
}

function nowUtcStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

/**
 * Builds the correct downlink ACK frame for a parsed uplink frame, per the
 * protocol document's "Downlink" examples for each packet type.
 *
 * @param {object} parsed - output of parseFrame()
 * @returns {string|null} the full ACK frame, ready to write to the socket
 */
function buildAck(parsed) {
  if (!parsed || !parsed.id || !parsed.imei) return null;

  const serialRaw = parsed.serialNumberRaw || '0000';

  if (parsed.type === 'heartbeat') {
    // Downlink: ACK^SYNC,UTC Time (yyyymmddhhmmss)
    const content = `ACK^SYNC,${nowUtcStamp()}`;
    return buildFrame(parsed.id, parsed.imei, serialRaw, content);
  }

  if (parsed.type === 'position') {
    // Downlink: ACK^LOCA
    const content = 'ACK^LOCA';
    return buildFrame(parsed.id, parsed.imei, serialRaw, content);
  }

  if (parsed.type === 'info') {
    // Downlink: ACK^INFO, UTC time (yyyymmddhhmmss)
    const content = `ACK^INFO,${nowUtcStamp()}`;
    return buildFrame(parsed.id, parsed.imei, serialRaw, content);
  }

  // Unknown frame type — protocol doesn't define an ACK for this, so don't
  // send one rather than guessing at a malformed reply.
  return null;
}

module.exports = {
  parseFrame,
  inferBehaviour,
  buildAck,
  // exported for testing/debugging if useful elsewhere
  _internal: { splitContent, decodeAlert, decodeGdata, decodeCell, decodeWifi },
};
