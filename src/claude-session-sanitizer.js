const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { once } = require('node:events');
const { finished } = require('node:stream/promises');

const DEFAULT_MAX_IMAGE_DIMENSION = 2000;

function claudeConfigRoot(options = {}) {
  const env = options.env || process.env;
  if (env.CLAUDE_CONFIG_DIR) {
    return path.resolve(String(env.CLAUDE_CONFIG_DIR));
  }
  return path.join(options.homeDir || os.homedir(), '.claude');
}

function isClaudeCliCommand(command) {
  const base = path.basename(String(command || '')).toLowerCase();
  return base === 'claude' || base === 'claude.cmd' || base === 'claude.exe';
}

function encodeClaudeProjectDir(repoRoot) {
  if (!repoRoot) return '';
  let resolved = path.resolve(String(repoRoot));
  if (/^[A-Z]:[\\/]/.test(resolved)) {
    resolved = resolved.charAt(0).toLowerCase() + resolved.slice(1);
  }
  return resolved.replace(/[:\\/]/g, '-');
}

async function pathExists(filePath) {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function findJsonlByName(rootDir, fileName) {
  let entries;
  try {
    entries = await fsp.readdir(rootDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isFile() && entry.name === fileName) {
      return fullPath;
    }
    if (entry.isDirectory()) {
      const match = await findJsonlByName(fullPath, fileName);
      if (match) return match;
    }
  }
  return null;
}

async function resolveClaudeSessionFile(options = {}) {
  const sessionId = String(options.sessionId || '').trim();
  if (!sessionId) return null;
  const root = claudeConfigRoot(options);
  const fileName = `${sessionId}.jsonl`;
  const encodedProject = encodeClaudeProjectDir(options.repoRoot || process.cwd());
  if (encodedProject) {
    const direct = path.join(root, 'projects', encodedProject, fileName);
    if (await pathExists(direct)) {
      return direct;
    }
  }
  return findJsonlByName(path.join(root, 'projects'), fileName);
}

function readImageDimensions(source) {
  const data = source && source.data;
  if (typeof data !== 'string' || !data) return null;
  let buffer;
  try {
    buffer = Buffer.from(data, 'base64');
  } catch {
    return null;
  }
  if (buffer.length >= 24
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47) {
    return {
      format: 'png',
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      const isStartOfFrame = (marker >= 0xc0 && marker <= 0xc3)
        || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb)
        || (marker >= 0xcd && marker <= 0xcf);
      if (isStartOfFrame) {
        return {
          format: 'jpeg',
          width: buffer.readUInt16BE(offset + 7),
          height: buffer.readUInt16BE(offset + 5),
        };
      }
      if (!length || length < 2) break;
      offset += 2 + length;
    }
    return { format: 'jpeg', width: null, height: null };
  }
  return {
    format: source.media_type || 'image',
    width: null,
    height: null,
  };
}

function shouldReplaceImage(node, options) {
  if (!node || node.type !== 'image') return null;
  const source = node.source;
  if (!source || source.type !== 'base64' || typeof source.data !== 'string') return null;
  const dimensions = readImageDimensions(source);
  if (!dimensions) return null;
  const maxDimension = Number(options.maxDimension) || DEFAULT_MAX_IMAGE_DIMENSION;
  const overLimit = (dimensions.width != null && dimensions.width > maxDimension)
    || (dimensions.height != null && dimensions.height > maxDimension);
  return overLimit ? dimensions : null;
}

function sanitizeValue(value, options, stats) {
  if (!value || typeof value !== 'object') return { value, changed: false };
  const dimensions = shouldReplaceImage(value, options);
  if (dimensions) {
    stats.replacedImages++;
    stats.oversizedImages++;
    const width = dimensions.width == null ? '?' : dimensions.width;
    const height = dimensions.height == null ? '?' : dimensions.height;
    const format = dimensions.format || 'image';
    return {
      changed: true,
      value: {
        type: 'text',
        text: `[Image omitted by QA Panda: oversized ${format} ${width}x${height} exceeded Claude resume limit. The QAPanda transcript/browser evidence still contains the screenshot.]`,
      },
    };
  }

  let changed = false;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const result = sanitizeValue(value[index], options, stats);
      if (result.changed) {
        value[index] = result.value;
        changed = true;
      }
    }
    return { value, changed };
  }

  for (const key of Object.keys(value)) {
    const result = sanitizeValue(value[key], options, stats);
    if (result.changed) {
      value[key] = result.value;
      changed = true;
    }
  }
  return { value, changed };
}

function backupPathFor(filePath) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${filePath}.bak-qapanda-${stamp}`;
}

async function writeOrDrain(stream, text) {
  if (!stream.write(text)) {
    await once(stream, 'drain');
  }
}

async function sanitizeClaudeSessionImages(filePath, options = {}) {
  const stats = {
    filePath,
    changed: false,
    changedLines: 0,
    replacedImages: 0,
    oversizedImages: 0,
    backupPath: null,
    missing: false,
    parseErrors: 0,
  };
  if (!filePath || !await pathExists(filePath)) {
    stats.missing = true;
    return stats;
  }

  const tempPath = `${filePath}.qapanda-sanitize-${process.pid}-${Date.now()}.tmp`;
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const output = fs.createWriteStream(tempPath, { encoding: 'utf8' });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });

  try {
    for await (const line of reader) {
      if (!line.trim()) {
        await writeOrDrain(output, '\n');
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        stats.parseErrors++;
        await writeOrDrain(output, `${line}\n`);
        continue;
      }
      const beforeReplaced = stats.replacedImages;
      const result = sanitizeValue(parsed, options, stats);
      if (result.changed) {
        stats.changed = true;
        stats.changedLines++;
      }
      const lineText = result.changed || stats.replacedImages !== beforeReplaced
        ? JSON.stringify(result.value)
        : line;
      await writeOrDrain(output, `${lineText}\n`);
    }
    output.end();
    await finished(output);

    if (!stats.changed) {
      await fsp.rm(tempPath, { force: true });
      return stats;
    }

    stats.backupPath = backupPathFor(filePath);
    await fsp.copyFile(filePath, stats.backupPath);
    await fsp.copyFile(tempPath, filePath);
    await fsp.rm(tempPath, { force: true });
    return stats;
  } catch (error) {
    try { output.destroy(); } catch {}
    try { await fsp.rm(tempPath, { force: true }); } catch {}
    throw error;
  }
}

async function sanitizeClaudeSessionImagesForResume(options = {}) {
  const filePath = await resolveClaudeSessionFile(options);
  if (!filePath) {
    return {
      filePath: null,
      changed: false,
      missing: true,
      changedLines: 0,
      replacedImages: 0,
      oversizedImages: 0,
      backupPath: null,
      parseErrors: 0,
    };
  }
  return sanitizeClaudeSessionImages(filePath, options);
}

module.exports = {
  DEFAULT_MAX_IMAGE_DIMENSION,
  claudeConfigRoot,
  encodeClaudeProjectDir,
  isClaudeCliCommand,
  readImageDimensions,
  resolveClaudeSessionFile,
  sanitizeClaudeSessionImages,
  sanitizeClaudeSessionImagesForResume,
};
