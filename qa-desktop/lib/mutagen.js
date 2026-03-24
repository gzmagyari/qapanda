/**
 * Mutagen sync management — downloads Mutagen binary and manages sync sessions.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { exec, execSync } = require('node:child_process');
const https = require('node:https');
const http = require('node:http');

const MUTAGEN_VERSION = '0.18.1';
const MUTAGEN_BIN_DIR = path.join(os.homedir(), '.qa-agent', 'bin');

// Default ignore patterns for Mutagen sync
const SYNC_IGNORES = [
  'node_modules', 'dist', 'build', '.next', '.nuxt', '.turbo',
  'coverage', '__pycache__', '.venv', 'venv', '.env.local',
  '.cache', '.pytest_cache', '*.pyc',
];

/**
 * Get the path to the Mutagen binary, downloading if needed.
 */
async function getMutagenBin() {
  // Check PATH first
  const which = process.platform === 'win32' ? 'where mutagen' : 'which mutagen';
  try {
    const found = execSync(which, { encoding: 'utf8', timeout: 5000 }).trim().split('\n')[0];
    if (found) return found;
  } catch {}

  // Check local bin directory
  const exeName = process.platform === 'win32' ? 'mutagen.exe' : 'mutagen';
  const localBin = path.join(MUTAGEN_BIN_DIR, exeName);
  if (fs.existsSync(localBin)) return localBin;

  // Download
  console.error(`Downloading Mutagen v${MUTAGEN_VERSION}...`);
  fs.mkdirSync(MUTAGEN_BIN_DIR, { recursive: true });

  const system = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const ext = system === 'windows' ? 'zip' : 'tar.gz';
  const url = `https://github.com/mutagen-io/mutagen/releases/download/v${MUTAGEN_VERSION}/mutagen_${system}_${arch}_v${MUTAGEN_VERSION}.${ext}`;

  await downloadAndExtract(url, MUTAGEN_BIN_DIR, ext);

  if (!fs.existsSync(localBin)) {
    throw new Error('Failed to download Mutagen.');
  }

  if (process.platform !== 'win32') {
    fs.chmodSync(localBin, 0o755);
  }

  console.error(`Mutagen installed to ${localBin}`);
  return localBin;
}

/**
 * Download a URL and extract to a directory.
 */
function downloadAndExtract(url, destDir, ext) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? https.get : http.get;
    const follow = (u) => {
      get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          follow(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          try {
            if (ext === 'zip') {
              // Use tar or built-in extraction — for now shell out
              const tmpFile = path.join(destDir, '_download.zip');
              fs.writeFileSync(tmpFile, buf);
              execSync(`cd "${destDir}" && tar -xf _download.zip`, { encoding: 'utf8' });
              try { fs.unlinkSync(tmpFile); } catch {}
            } else {
              const tmpFile = path.join(destDir, '_download.tar.gz');
              fs.writeFileSync(tmpFile, buf);
              execSync(`tar -xzf "${tmpFile}" -C "${destDir}"`, { encoding: 'utf8' });
              try { fs.unlinkSync(tmpFile); } catch {}
            }
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    };
    follow(url);
  });
}

/**
 * Run a Mutagen command.
 */
async function runMutagen(args, options = {}) {
  const bin = await getMutagenBin();
  const cmd = `"${bin}" ${args.join(' ')}`;
  return new Promise((resolve) => {
    exec(cmd, { timeout: options.timeout || 60000 }, (err, stdout, stderr) => {
      resolve({
        code: err ? (err.code || 1) : 0,
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
      });
    });
  });
}

function syncSessionName(instanceName) {
  return `qa-sync-${instanceName}`;
}

function volumeName(instanceName) {
  return `qa-workspace-${instanceName}`;
}

/**
 * Read .gitignore patterns from a workspace (filtering out .env patterns).
 */
function gitignorePatterns(hostPath) {
  const gitignorePath = path.join(hostPath, '.gitignore');
  if (!fs.existsSync(gitignorePath)) return [];
  const content = fs.readFileSync(gitignorePath, 'utf8');
  return content.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && !l.startsWith('!'))
    .map(l => l.replace(/^\/|\/$/g, ''))
    .filter(l => l && !l.startsWith('.env'));
}

/**
 * Start a Mutagen sync session for workspace files.
 */
async function startSync(instanceName, hostPath, containerName) {
  const session = syncSessionName(instanceName);
  const safePath = hostPath.replace(/\\/g, '/');

  const args = [
    'sync', 'create',
    `--name=${session}`,
    '--sync-mode=two-way-safe',
    '--ignore-vcs',
    '--permissions-mode=manual',
    '--default-file-mode=0777',
    '--default-directory-mode=0777',
  ];

  for (const pattern of SYNC_IGNORES) {
    args.push(`--ignore=${pattern}`);
  }
  for (const pattern of gitignorePatterns(hostPath)) {
    args.push(`--ignore=${pattern}`);
  }

  args.push(safePath, `docker://${containerName}/workspace`);

  const result = await runMutagen(args);
  if (result.code !== 0) {
    console.error(`Failed to start sync: ${result.stderr}`);
    return false;
  }

  // Wait for initial sync
  console.error('Syncing workspace files...');
  await runMutagen(['sync', 'flush', session], { timeout: 120000 });
  return true;
}

/**
 * Stop a Mutagen sync session.
 */
async function stopSync(instanceName) {
  const session = syncSessionName(instanceName);
  await runMutagen(['sync', 'terminate', session]);
}

/**
 * Get sync status for an instance.
 */
async function getSyncStatus(instanceName) {
  const session = syncSessionName(instanceName);
  const result = await runMutagen(['sync', 'list', session]);
  if (result.code !== 0) return 'no sync';
  const output = result.stdout;
  if (output.includes('Watching for changes')) return 'synced';
  if (output.includes('Staging') || output.includes('Applying')) return 'syncing';
  if (output.includes('Paused')) return 'paused';
  if (output.includes('Connecting') || output.includes('Waiting')) return 'connecting';
  return 'active';
}

module.exports = {
  getMutagenBin,
  runMutagen,
  syncSessionName,
  volumeName,
  gitignorePatterns,
  startSync,
  stopSync,
  getSyncStatus,
  SYNC_IGNORES,
};
