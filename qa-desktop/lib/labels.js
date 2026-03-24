/**
 * Docker label constants and parsing for qa-desktop instances.
 */

const LABEL = 'qa-desktop-instance';
const LABEL_API_PORT = 'qa-desktop.api-port';
const LABEL_VNC_PORT = 'qa-desktop.vnc-port';
const LABEL_NOVNC_PORT = 'qa-desktop.novnc-port';

// Internal container ports (fixed — these are inside the container)
const CONTAINER_API_PORT = 8765;
const CONTAINER_VNC_PORT = 5901;
const CONTAINER_NOVNC_PORT = 6080;

// Docker Hub image (published release)
const REGISTRY_IMAGE = 'gzmagyari/qa-agent-desktop:latest';
// Local dev image (from docker compose build in QAAgentDesktop repo)
const DEV_IMAGE = 'qaagentdesktop-agent-desktop';

/**
 * Parse a docker ps --format line into an instance object.
 * Format: ID\tNames\tStatus\tapi-port\tvnc-port\tnovnc-port
 */
function parseInstanceLine(line) {
  const parts = line.split('\t');
  if (parts.length < 6) return null;
  const [cid, cname, status, apiP, vncP, novncP] = parts;
  const name = cname.startsWith('qa-desktop-') ? cname.replace('qa-desktop-', '') : cname;
  return {
    name,
    containerName: cname,
    containerId: cid,
    apiPort: parseInt(apiP, 10) || 0,
    vncPort: parseInt(vncP, 10) || 0,
    novncPort: parseInt(novncP, 10) || 0,
    status,
  };
}

module.exports = {
  LABEL,
  LABEL_API_PORT,
  LABEL_VNC_PORT,
  LABEL_NOVNC_PORT,
  CONTAINER_API_PORT,
  CONTAINER_VNC_PORT,
  CONTAINER_NOVNC_PORT,
  REGISTRY_IMAGE,
  DEV_IMAGE,
  parseInstanceLine,
};
