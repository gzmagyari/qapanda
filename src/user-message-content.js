const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { ensureDir } = require('./utils');

const IMAGE_PLACEHOLDER = '[Image preserved separately]';

const MIME_EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
  'image/x-icon': '.ico',
  'image/heic': '.heic',
  'image/heif': '.heif',
};

function normalizeAttachmentList(attachments) {
  return (Array.isArray(attachments) ? attachments : [])
    .filter((attachment) => attachment && typeof attachment === 'object');
}

function userAssetsDir(manifest) {
  if (manifest && manifest.files && manifest.files.userAssetsDir) {
    return manifest.files.userAssetsDir;
  }
  const runDir = manifest && manifest.runDir ? manifest.runDir : null;
  if (!runDir) return null;
  return path.join(runDir, 'assets', 'user-input');
}

function fileExtensionForMimeType(mimeType, fileName) {
  const explicit = path.extname(String(fileName || '')).trim();
  if (explicit) return explicit;
  const normalizedMime = String(mimeType || '').trim().toLowerCase();
  return MIME_EXTENSIONS[normalizedMime] || '.img';
}

function normalizedDisplayFileName(fileName, mimeType, index) {
  const trimmed = String(fileName || '').trim();
  if (trimmed) return path.basename(trimmed);
  return `pasted-image-${index}${fileExtensionForMimeType(mimeType, fileName)}`;
}

function parseImageDataUrl(dataUrl) {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(String(dataUrl || '').trim());
  if (!match) {
    throw new Error('Invalid image data URL');
  }
  return {
    mimeType: String(match[1] || '').trim().toLowerCase() || 'image/png',
    base64: match[2],
  };
}

function assetPartDataUrl(part, options = {}) {
  if (!part || typeof part !== 'object') return null;
  if (typeof part.dataUrl === 'string' && part.dataUrl.startsWith('data:')) {
    return part.dataUrl;
  }
  const filePath = typeof part.filePath === 'string' ? part.filePath : '';
  if (!filePath) return null;
  try {
    const bytes = (options.readFileSync || fs.readFileSync)(filePath);
    return `data:${part.mimeType || 'image/png'};base64,${Buffer.from(bytes).toString('base64')}`;
  } catch {
    return null;
  }
}

function displayAttachmentsFromContent(content, options = {}) {
  if (!Array.isArray(content)) return [];
  const attachments = [];
  for (const part of content) {
    if (!part || typeof part !== 'object' || part.type !== 'image_asset') continue;
    const dataUrl = assetPartDataUrl(part, options);
    if (!dataUrl) continue;
    attachments.push({
      assetId: part.assetId || null,
      fileName: part.fileName || null,
      mimeType: part.mimeType || 'image/png',
      width: Number.isFinite(part.width) ? Number(part.width) : null,
      height: Number.isFinite(part.height) ? Number(part.height) : null,
      size: Number.isFinite(part.size) ? Number(part.size) : null,
      dataUrl,
    });
  }
  return attachments;
}

function textOnlyFromContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
    return '';
  }
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if ((part.type === 'text' || part.type === 'input_text') && typeof part.text === 'string') return part.text;
    if (typeof part.text === 'string') return part.text;
    return '';
  }).filter(Boolean).join('');
}

function textWithImagePlaceholder(content, options = {}) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  const placeholder = options.imagePlaceholder || IMAGE_PLACEHOLDER;
  if (!Array.isArray(content)) {
    if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
    return '';
  }
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if ((part.type === 'text' || part.type === 'input_text') && typeof part.text === 'string') return part.text;
    if (part.type === 'image_asset' || part.type === 'image_url') return placeholder;
    if (typeof part.text === 'string') return part.text;
    return '';
  }).filter(Boolean).join('\n');
}

function buildUserMessageContent(text, assetParts = []) {
  const normalizedText = String(text || '');
  const normalizedAssets = normalizeAttachmentList(assetParts);
  if (normalizedAssets.length === 0) {
    return normalizedText;
  }
  const content = [];
  if (normalizedText) {
    content.push({ type: 'text', text: normalizedText });
  }
  for (const part of normalizedAssets) {
    content.push({
      type: 'image_asset',
      assetId: part.assetId || null,
      fileName: part.fileName || null,
      mimeType: part.mimeType || 'image/png',
      width: Number.isFinite(part.width) ? Number(part.width) : null,
      height: Number.isFinite(part.height) ? Number(part.height) : null,
      size: Number.isFinite(part.size) ? Number(part.size) : null,
      assetPath: part.assetPath || null,
      filePath: part.filePath || null,
    });
  }
  return content;
}

function buildUserMessageDisplay(content, options = {}) {
  return {
    text: textOnlyFromContent(content),
    attachments: displayAttachmentsFromContent(content, options),
  };
}

function buildProviderUserContent(content, options = {}) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return textOnlyFromContent(content);
  }
  const providerContent = [];
  for (const part of content) {
    if (typeof part === 'string') {
      if (part) providerContent.push({ type: 'text', text: part });
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    if ((part.type === 'text' || part.type === 'input_text') && typeof part.text === 'string') {
      providerContent.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type !== 'image_asset') continue;
    const dataUrl = assetPartDataUrl(part, options);
    if (!dataUrl) continue;
    providerContent.push({
      type: 'image_url',
      image_url: {
        url: dataUrl,
        format: part.mimeType || 'image/png',
      },
    });
  }
  if (providerContent.length === 1 && providerContent[0].type === 'text') {
    return providerContent[0].text;
  }
  return providerContent;
}

async function persistUserMessageAttachments(manifest, requestId, attachments) {
  const normalized = normalizeAttachmentList(attachments);
  if (normalized.length === 0) return [];
  const assetsRoot = userAssetsDir(manifest);
  if (!assetsRoot) {
    throw new Error('No user asset directory configured for this run');
  }
  const requestDir = path.join(assetsRoot, String(requestId || 'request'));
  await ensureDir(requestDir);

  const persisted = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const attachment = normalized[index];
    const imageIndex = index + 1;
    const parsed = parseImageDataUrl(attachment.dataUrl || attachment.url || '');
    const displayFileName = normalizedDisplayFileName(attachment.fileName, attachment.mimeType || parsed.mimeType, imageIndex);
    const extension = fileExtensionForMimeType(attachment.mimeType || parsed.mimeType, displayFileName);
    const storedFileName = `${String(imageIndex).padStart(2, '0')}${extension}`;
    const filePath = path.join(requestDir, storedFileName);
    const bytes = Buffer.from(parsed.base64, 'base64');
    await fsp.writeFile(filePath, bytes);
    persisted.push({
      type: 'image_asset',
      assetId: `user:${requestId}:${imageIndex}`,
      fileName: displayFileName,
      mimeType: attachment.mimeType || parsed.mimeType || 'image/png',
      width: Number.isFinite(attachment.width) ? Number(attachment.width) : null,
      height: Number.isFinite(attachment.height) ? Number(attachment.height) : null,
      size: bytes.length,
      assetPath: manifest && manifest.runDir
        ? path.relative(manifest.runDir, filePath).replace(/\\/g, '/')
        : storedFileName,
      filePath: path.resolve(filePath),
    });
  }
  return persisted;
}

function userMessageSummaryText(text, attachments) {
  const normalizedText = String(text || '').trim();
  if (normalizedText) return normalizedText;
  const count = normalizeAttachmentList(attachments).length;
  if (count <= 1) return '[Image message]';
  return `[Image message x${count}]`;
}

function sanitizeUserAttachmentsForChatLog(attachments) {
  return normalizeAttachmentList(attachments).map((attachment) => ({
    assetId: attachment.assetId || null,
    fileName: attachment.fileName || null,
    mimeType: attachment.mimeType || 'image/png',
    width: Number.isFinite(attachment.width) ? Number(attachment.width) : null,
    height: Number.isFinite(attachment.height) ? Number(attachment.height) : null,
    size: Number.isFinite(attachment.size) ? Number(attachment.size) : null,
  }));
}

module.exports = {
  IMAGE_PLACEHOLDER,
  assetPartDataUrl,
  buildProviderUserContent,
  buildUserMessageContent,
  buildUserMessageDisplay,
  displayAttachmentsFromContent,
  normalizeAttachmentList,
  persistUserMessageAttachments,
  sanitizeUserAttachmentsForChatLog,
  textOnlyFromContent,
  textWithImagePlaceholder,
  userMessageSummaryText,
};
