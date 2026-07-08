let activeScan = false;

function lockScan() {
  if (activeScan) return false;
  activeScan = true;
  return true;
}

function unlockScan() {
  activeScan = false;
}

module.exports = {
  lockScan,
  unlockScan,
};