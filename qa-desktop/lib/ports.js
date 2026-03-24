/**
 * Find free ports by binding to port 0 and letting the OS assign.
 */
const net = require('node:net');

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/**
 * Find N free ports.
 */
async function findFreePorts(count) {
  const ports = [];
  for (let i = 0; i < count; i++) {
    ports.push(await findFreePort());
  }
  return ports;
}

module.exports = { findFreePort, findFreePorts };
