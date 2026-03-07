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
  safeJsonParse,
  slugify,
  summarizeError,
  tailLines,
  truncate,
  writeJson,
  writeText,
};
