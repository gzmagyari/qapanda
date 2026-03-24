/**
 * Docker CLI helpers — thin wrappers around child_process.exec.
 */
const { execFile, execFileSync } = require('node:child_process');
const { LABEL, LABEL_API_PORT, LABEL_VNC_PORT, LABEL_NOVNC_PORT, REGISTRY_IMAGE, DEV_IMAGE, parseInstanceLine } = require('./labels');

/**
 * Run a docker command and return { code, stdout, stderr }.
 * Uses execFile (not exec) so arguments with spaces are passed correctly.
 */
function docker(args, options = {}) {
  return new Promise((resolve) => {
    execFile('docker', args, { timeout: options.timeout || 30000, maxBuffer: 10 * 1024 * 1024, ...options }, (err, stdout, stderr) => {
      resolve({
        code: err ? (err.code || err.status || 1) : 0,
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
      });
    });
  });
}

/**
 * Run a docker command synchronously and return stdout. Throws on failure.
 */
function dockerSync(args) {
  try {
    return execFileSync('docker', args, { encoding: 'utf8', timeout: 30000 }).trim();
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString().trim() : e.message;
    throw new Error(`docker ${args[0]} failed: ${stderr}`);
  }
}

/**
 * List all qa-desktop instances.
 */
async function listInstances() {
  const fmt = '{{.ID}}\\t{{.Names}}\\t{{.Status}}\\t' +
    `{{.Label "${LABEL_API_PORT}"}}\\t` +
    `{{.Label "${LABEL_VNC_PORT}"}}\\t` +
    `{{.Label "${LABEL_NOVNC_PORT}"}}`;

  const result = await docker(['ps', '-a', '--filter', `label=${LABEL}`, '--format', fmt]);
  if (result.code !== 0 || !result.stdout) return [];

  return result.stdout.split('\n')
    .map(line => parseInstanceLine(line.trim()))
    .filter(Boolean);
}

/**
 * Find a specific instance by name.
 */
async function findInstance(name) {
  const instances = await listInstances();
  return instances.find(i => i.name === name) || null;
}

/**
 * Check if a Docker image exists locally.
 */
async function imageExists(imageRef) {
  const result = await docker(['images', '-q', imageRef]);
  return result.code === 0 && result.stdout.length > 0;
}

/**
 * Get the image name to use. Checks in order:
 * 1. Snapshot image (if tag provided)
 * 2. Docker Hub image (gzmagyari/qa-agent-desktop:latest)
 * 3. Legacy local image (qaagentdesktop-agent-desktop, from docker compose build)
 *
 * If no image is found locally, auto-pulls from Docker Hub.
 *
 * @param {string|null} snapshotTag - Snapshot tag to check first
 * @param {function} [onProgress] - Optional callback for pull progress
 * @returns {Promise<string|null>} Image name or null if unavailable
 */
async function getImageName(snapshotTag, onProgress) {
  // 1. Check snapshot
  if (snapshotTag) {
    const tag = `${snapshotTag}:latest`;
    if (await imageExists(tag)) return tag;
  }

  // 2. Check local dev image (from docker compose build — takes priority for development)
  for (const candidate of [DEV_IMAGE, `${DEV_IMAGE}:latest`]) {
    if (await imageExists(candidate)) return candidate;
  }

  // 3. Check Docker Hub image locally
  if (await imageExists(REGISTRY_IMAGE)) return REGISTRY_IMAGE;

  // 4. Auto-pull from Docker Hub
  if (onProgress) onProgress(`Downloading ${REGISTRY_IMAGE}...`);
  else console.error(`Image not found locally. Pulling ${REGISTRY_IMAGE}...`);
  try {
    await pullImage(REGISTRY_IMAGE, onProgress);
    return REGISTRY_IMAGE;
  } catch (e) {
    if (onProgress) onProgress(`Failed to pull image: ${e.message}`);
    else console.error(`Failed to pull image: ${e.message}`);
    return null;
  }
}

/**
 * Stop and remove a container by name.
 */
async function stopContainer(containerName) {
  await docker(['stop', containerName], { timeout: 60000 });
  await docker(['rm', containerName]);
}

/**
 * Remove a Docker volume.
 */
async function removeVolume(volumeName) {
  await docker(['volume', 'rm', volumeName]);
}

/**
 * Create a Docker volume.
 */
async function createVolume(volumeName) {
  await docker(['volume', 'create', volumeName]);
}

/**
 * Commit a container as a snapshot image.
 */
async function commitContainer(containerName, tag) {
  const result = await docker(['commit', containerName, tag], { timeout: 600000 });
  if (result.code !== 0) throw new Error(`docker commit failed: ${result.stderr}`);
  return result.stdout;
}

/**
 * Remove a Docker image.
 */
async function removeImage(tag) {
  const result = await docker(['rmi', tag]);
  if (result.code !== 0) throw new Error(`docker rmi failed: ${result.stderr}`);
}

/**
 * Pull a Docker image from a registry.
 */
async function pullImage(imageRef, onProgress) {
  return new Promise((resolve, reject) => {
    const { exec } = require('node:child_process');
    const child = exec(`docker pull ${imageRef}`, { timeout: 1200000 }); // 20 min timeout — exec is fine here for streaming
    let lastLine = '';
    if (child.stdout) {
      child.stdout.on('data', (data) => {
        lastLine = data.toString().trim();
        if (onProgress) onProgress(lastLine);
      });
    }
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`docker pull failed (code ${code}): ${lastLine}`));
    });
    child.on('error', reject);
  });
}

module.exports = {
  docker,
  dockerSync,
  listInstances,
  findInstance,
  imageExists,
  getImageName,
  stopContainer,
  removeVolume,
  createVolume,
  commitContainer,
  removeImage,
  pullImage,
};
