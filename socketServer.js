/**
 * TCP Socket Server — HCS048 Ear Tag Ingestion Gateway
 *
 * Production hardening:
 *   ✓ TCP_MAX_CONNECTIONS limit from env
 *   ✓ Per-connection buffer overflow guard (TCP_MAX_BUFFER_BYTES)
 *   ✓ All requires at top of file (no inline require)
 *   ✓ Graceful server.close() exported for shutdown handler
 *   ✓ Connection counter logged
 */

'use strict';
const net             = require('net');
const { parseFrame, inferBehaviour, buildAck } = require('../parsers/hcs048Parser');
const { CattleTag, LocationHistory, AlarmEvent } = require('../models/CattleTag');
const geofenceService = require('../services/geofenceService');

const MAX_CONNECTIONS  = parseInt(process.env.TCP_MAX_CONNECTIONS  || '500',  10);
const MAX_BUFFER_BYTES = parseInt(process.env.TCP_MAX_BUFFER_BYTES || '4096', 10);

// In-memory map: IMEI → last packet Date (packet interval calc only)
const lastPacketTime = new Map();
let   connectionCount = 0;
let   wsBroadcast     = null;

function setWsBroadcast(fn) { wsBroadcast = fn; }

function broadcast(event, data) {
  if (wsBroadcast) wsBroadcast(JSON.stringify({ event, data }));
}

function createTcpServer(port) {
  const server = net.createServer((socket) => {
    // Enforce max connection limit
    connectionCount++;
    if (connectionCount > MAX_CONNECTIONS) {
      console.warn(`[TCP] Max connections (${MAX_CONNECTIONS}) reached — rejecting ${socket.remoteAddress}`);
      socket.destroy();
      connectionCount--;
      return;
    }

    const remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`[TCP] New connection: ${remoteAddr} (active: ${connectionCount})`);
    let buffer = '';

    socket.on('data', async (chunk) => {
      buffer += chunk.toString('ascii');

      // Buffer overflow guard — drop and close malicious/broken connection
      if (Buffer.byteLength(buffer, 'utf8') > MAX_BUFFER_BYTES) {
        console.warn(`[TCP] Buffer overflow from ${remoteAddr} — closing connection`);
        buffer = '';
        socket.destroy();
        return;
      }

      let idx;
      while ((idx = buffer.indexOf('$')) !== -1) {
        const rawFrame = buffer.slice(0, idx + 1);
        buffer = buffer.slice(idx + 1);
        await handleFrame(rawFrame.trim(), socket);
      }
    });

    socket.on('close', () => {
      connectionCount = Math.max(0, connectionCount - 1);
      console.log(`[TCP] Disconnected: ${remoteAddr} (active: ${connectionCount})`);
    });

    socket.on('error', err => {
      console.error(`[TCP] Socket error (${remoteAddr}):`, err.message);
    });

    socket.setKeepAlive(true, 30000);
    socket.setTimeout(300000);   // 5-minute idle timeout
    socket.on('timeout', () => {
      console.warn(`[TCP] Idle timeout: ${remoteAddr}`);
      socket.destroy();
    });
  });

  server.maxConnections = MAX_CONNECTIONS;

  server.listen(port, () => {
    console.log(`[TCP] HCS048 ingestion server listening on port ${port} (max ${MAX_CONNECTIONS} connections)`);
  });

  server.on('error', err => console.error('[TCP] Server error:', err.message));

  return server;
}

async function handleFrame(rawFrame, socket) {
  if (!rawFrame || rawFrame.length < 10) return;

  const packet = parseFrame(rawFrame);
  if (!packet) {
    console.warn('[TCP] Unparseable frame:', rawFrame.slice(0, 80));
    return;
  }

  console.log(`[TCP] ${packet.packetType || 'UNKNOWN'} | IMEI:${packet.imei} | Speed:${packet.speed ?? '-'} | ALERT:${packet.rawAlertHex ?? '-'}`);

  const ack = buildAck(packet);
  if (ack && socket.writable) socket.write(ack);

  try {
    if      (packet.packetType === 'INFO') await handleInfoPacket(packet);
    else if (packet.packetType === 'LOCA') await handleLocaPacket(packet);
    else if (packet.packetType === 'SYNC') await handleSyncPacket(packet);
  } catch (err) {
    console.error(`[TCP] DB error for IMEI ${packet.imei}:`, err.message);
  }
}

async function handleInfoPacket(packet) {
  await CattleTag.findOneAndUpdate(
    { imei: packet.imei },
    { $set: {
      tagId: packet.imei, imei: packet.imei,
      imsi: packet.imsi, iccid: packet.iccid,
      owner: packet.owner, firmware: packet.firmware,
      model: packet.model, plmn: packet.plmn,
    }},
    { upsert: true, new: true }
  );
}

async function handleSyncPacket(packet) {
  const update = {
    lastPacketAt: packet.parsedAt,
    serialNumber: packet.serial?.toString(16),
  };
  if (packet.battery   !== undefined) update.battery   = packet.battery;
  if (packet.signal    !== undefined) update.signal    = packet.signal;
  if (packet.syncCount !== undefined) update.syncCount = packet.syncCount;
  await CattleTag.findOneAndUpdate({ imei: packet.imei }, { $set: update }, { upsert: true });
}

async function handleLocaPacket(packet) {
  if (!packet.latitude && !packet.longitude) return;

  const imei = packet.imei;
  const now  = packet.parsedAt;

  const behaviour = inferBehaviour(packet);

  const prevTime = lastPacketTime.get(imei) || null;
  const packetInterval = prevTime ? Math.round((now - prevTime) / 1000) : null;
  lastPacketTime.set(imei, now);

  let perimeterBreach = false;
  if (packet.latitude && packet.longitude) {
    perimeterBreach = await geofenceService.checkBreach(imei, packet.latitude, packet.longitude);
  }
  if (packet.alarms) packet.alarms.perimeterBreach = perimeterBreach;

  await CattleTag.findOneAndUpdate(
    { imei },
    { $set: {
      tagId: imei, imei,
      latitude: packet.latitude, longitude: packet.longitude,
      location: { type: 'Point', coordinates: [packet.longitude, packet.latitude] },
      speed: packet.speed, heading: packet.heading, altitude: packet.altitude,
      satellites: packet.satellites, gpsFixed: packet.gpsFixed,
      gpsTimestamp: packet.gpsTime, locationType: packet.locationType,
      battery: packet.battery, signal: packet.signal,
      behaviourState: behaviour, behaviourUpdatedAt: now,
      lastPacketAt: now, serialNumber: packet.serial?.toString(16),
      rawAlertHex: packet.rawAlertHex, alarms: packet.alarms || {},
      packetInterval,
    }},
    { upsert: true, new: true }
  );

  await LocationHistory.create({
    tagId: imei, imei,
    timestamp:     packet.gpsTime || now,
    location:      { type: 'Point', coordinates: [packet.longitude, packet.latitude] },
    latitude:      packet.latitude, longitude: packet.longitude,
    speed:         packet.speed,    heading:   packet.heading,
    altitude:      packet.altitude, locationType: packet.locationType,
    battery:       packet.battery,  signal:    packet.signal,
    behaviourState: behaviour,      packetType: 'LOCA',
    rawAlertHex:   packet.rawAlertHex,
    vibration:     packet.alarms?.vibration,
    lowBattery:    packet.alarms?.lowBattery,
    sos:           packet.alarms?.sos,
  });

  await logAlarmEvents(packet, perimeterBreach, now);

  broadcast('LOCATION_UPDATE', {
    imei, tagId: imei,
    latitude: packet.latitude, longitude: packet.longitude,
    speed: packet.speed, battery: packet.battery,
    behaviourState: behaviour, alarms: packet.alarms,
    timestamp: now,
  });

  if (perimeterBreach || packet.alarms?.lowBattery ||
      packet.alarms?.sos || packet.alarms?.vibration) {
    broadcast('ALARM', {
      imei, tagId: imei,
      alarms: packet.alarms,
      latitude: packet.latitude, longitude: packet.longitude,
      timestamp: now,
    });
  }
}

async function logAlarmEvents(packet, perimeterBreach, now) {
  const alarmMap = [
    { flag: packet.alarms?.lowBattery, type: 'LOW_BATTERY',      severity: 'LOW'      },
    { flag: packet.alarms?.sos,        type: 'SOS',              severity: 'CRITICAL'  },
    { flag: packet.alarms?.vibration,  type: 'VIBRATION',        severity: 'HIGH'      },
    { flag: perimeterBreach,           type: 'PERIMETER_BREACH', severity: 'HIGH'      },
  ];

  for (const { flag, type, severity } of alarmMap) {
    if (!flag) continue;
    const recent = await AlarmEvent.findOne({
      imei: packet.imei, type, acknowledged: false,
      timestamp: { $gte: new Date(now - 10 * 60 * 1000) },
    }).lean();
    if (!recent) {
      await AlarmEvent.create({
        tagId: packet.imei, imei: packet.imei,
        timestamp: now, type, severity,
        latitude: packet.latitude, longitude: packet.longitude,
        rawAlertHex: packet.rawAlertHex,
      });
    }
  }
}

module.exports = { createTcpServer, setWsBroadcast };
