const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readText(filePath, fallback = '') {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

async function readTextTail(filePath, options = {}) {
  const fallback = Object.prototype.hasOwnProperty.call(options, 'fallback')
    ? options.fallback
    : '';
  const requestedBytes = Number.isFinite(options.bytes)
    ? Math.max(1, Number(options.bytes))
    : 256 * 1024;
  const trimPartialFirstLine = options.trimPartialFirstLine !== false;
  const truncationBannerText = typeof options.truncationBannerText === 'string' && options.truncationBannerText.trim()
    ? options.truncationBannerText
    : null;

  let handle = null;
  try {
    handle = await fs.open(filePath, 'r');
    const stat = await handle.stat();
    const fileSize = Number(stat && stat.size) || 0;
    if (fileSize <= 0) {
      return { text: '', truncated: false, fileSize: 0, bytesRead: 0, startOffset: 0 };
    }

    const bytesRead = Math.min(fileSize, requestedBytes);
    const startOffset = Math.max(0, fileSize - bytesRead);
    const buffer = Buffer.alloc(bytesRead);
    await handle.read(buffer, 0, bytesRead, startOffset);

    let sliceStart = 0;
    if (trimPartialFirstLine && startOffset > 0) {
      const newlineByteIndex = buffer.indexOf(0x0A);
      sliceStart = newlineByteIndex >= 0 ? newlineByteIndex + 1 : bytesRead;
    }

    let text = buffer.subarray(sliceStart).toString('utf8');
    const truncated = startOffset > 0;
    if (truncated && truncationBannerText) {
      text = `${truncationBannerText}\n${text}`;
    }

    return {
      text,
      truncated,
      fileSize,
      bytesRead,
      startOffset,
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { text: fallback, truncated: false, fileSize: 0, bytesRead: 0, startOffset: 0 };
    }
    throw error;
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }
}

async function writeText(filePath, text) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, text, 'utf8');
}

async function appendText(filePath, text) {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, text, 'utf8');
}

async function readJson(filePath, fallback = null) {
  const text = await readText(filePath, null);
  if (text == null) {
    return fallback;
  }
  return JSON.parse(text);
}

async function writeJson(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeText(filePath, text);
}

async function appendJsonl(filePath, value) {
  await appendText(filePath, `${JSON.stringify(value)}\n`);
}

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix = '') {
  const id = crypto.randomUUID();
  return prefix ? `${prefix}${id}` : id;
}

function truncate(text, maxLength = 240) {
  const value = String(text || '');
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function slugify(text, maxLength = 40) {
  const slug = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength);
  return slug || 'run';
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parsePossiblyFencedJson(text) {
  const raw = String(text || '').trim();
  if (!raw) {
    throw new Error('Expected JSON output, but the file was empty.');
  }

  const direct = safeJsonParse(raw);
  if (direct != null) {
    return direct;
  }

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    const parsed = safeJsonParse(fenced[1]);
    if (parsed != null) {
      return parsed;
    }
  }

  throw new Error(`Could not parse JSON output:\n${truncate(raw, 2000)}`);
}

function parseInteger(value, optionName) {
  if (value == null) {
    return null;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer for ${optionName}: ${value}`);
  }
  return parsed;
}

function parseNumber(value, optionName) {
  if (value == null) {
    return null;
  }
  const parsed = Number(String(value));
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number for ${optionName}: ${value}`);
  }
  return parsed;
}

function summarizeError(error) {
  if (!error) {
    return 'Unknown error';
  }
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

function tailLines(text, count) {
  const lines = String(text || '').split(/\r?\n/).filter(Boolean);
  return lines.slice(-count);
}

async function readAllStdin() {
  if (process.stdin.isTTY) {
    return '';
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseKeyValue(entry) {
  const index = String(entry).indexOf('=');
  if (index === -1) {
    return [String(entry), ''];
  }
  return [String(entry).slice(0, index), String(entry).slice(index + 1)];
}

module.exports = {
  appendJsonl,
  appendText,
  ensureDir,
  nowIso,
  parseInteger,
  parseKeyValue,
  parseNumber,
  parsePossiblyFencedJson,
  pathExists,
  randomId,
  readAllStdin,
  readJson,
  readText,
  readTextTail,
  safeJsonParse,
  slugify,
  summarizeError,
  tailLines,
  truncate,
  writeJson,
  writeText,
};
