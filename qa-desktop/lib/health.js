/**
 * Health check polling for container API.
 */
const http = require('node:http');

/**
 * Check if the container's health endpoint is responding.
 */
function checkHealth(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/healthz`, { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json && json.ok === true);
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * Poll the health endpoint until it responds or timeout.
 * @param {number} port - API port
 * @param {number} timeoutMs - Max time to wait (default 20 min)
 * @param {number} intervalMs - Poll interval (default 2s)
 * @param {function} onProgress - Optional callback with status messages
 * @returns {Promise<boolean>}
 */
async function waitForHealth(port, timeoutMs = 20 * 60 * 1000, intervalMs = 2000, onProgress) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await checkHealth(port);
    if (ok) return true;
    if (onProgress) onProgress(`Waiting for container health... (${Math.round((Date.now() - start) / 1000)}s)`);
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

module.exports = { checkHealth, waitForHealth };
