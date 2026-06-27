// Stub sleep/inactivity detector — replace with real logic later
let intervalHandle = null;

function start() {
  console.log('[sleepDetector] Started monitoring (stub - no logic implemented yet)');
  intervalHandle = setInterval(() => {
    // TODO: check device packet gaps vs SAVE mode to flag sleep vs offline
  }, 60000);
}

function stop() {
  console.log('[sleepDetector] Stopped monitoring');
  if (intervalHandle) clearInterval(intervalHandle);
}

module.exports = { start, stop };
