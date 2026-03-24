/**
 * Snapshot tag derivation and management.
 * Must match the Python implementation for compatibility.
 */
const crypto = require('node:crypto');
const path = require('node:path');
const { docker, imageExists } = require('./docker');

/**
 * Derive a snapshot image tag from a workspace path.
 * Must produce the same tag as the Python _snapshot_tag_for_workspace().
 *
 * Python logic:
 *   normalized = str(Path(workspace).resolve())
 *   base = Path(workspace).name.lower().replace(" ", "-")
 *   base = "".join(c for c in base if c.isalnum() or c == "-") or "workspace"
 *   h = hashlib.sha256(normalized.encode()).hexdigest()[:8]
 *   return f"qa-snapshot-{base}-{h}"
 */
function snapshotTagForWorkspace(workspace) {
  let normalized = path.resolve(workspace);
  // Normalize Windows drive letter to uppercase for consistent hashing
  if (process.platform === 'win32' && /^[a-z]:/.test(normalized)) {
    normalized = normalized[0].toUpperCase() + normalized.slice(1);
  }
  let base = path.basename(workspace).toLowerCase().replace(/ /g, '-');
  base = base.replace(/[^a-z0-9-]/g, '') || 'workspace';
  const h = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 8);
  return `qa-snapshot-${base}-${h}`;
}

/**
 * Check if a snapshot image exists for a workspace.
 * @returns {{ exists: boolean, tag: string }}
 */
async function snapshotExists(workspace) {
  const tag = `${snapshotTagForWorkspace(workspace)}:latest`;
  const exists = await imageExists(tag);
  return { exists, tag };
}

module.exports = { snapshotTagForWorkspace, snapshotExists };
