const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildProviderUserContent,
  buildUserMessageContent,
  buildUserMessageDisplay,
  persistUserMessageAttachments,
} = require('../../src/user-message-content');

describe('user-message-content', () => {
  it('persists pasted attachments as run-scoped image assets', async () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qpanda-user-assets-'));
    const manifest = {
      runDir,
      files: {
        userAssetsDir: path.join(runDir, 'assets', 'user-input'),
      },
    };

    const parts = await persistUserMessageAttachments(manifest, 'req-0001', [{
      fileName: 'clipboard.png',
      mimeType: 'image/png',
      width: 16,
      height: 9,
      dataUrl: 'data:image/png;base64,ZmFrZQ==',
    }]);

    assert.equal(parts.length, 1);
    assert.equal(parts[0].type, 'image_asset');
    assert.equal(parts[0].assetId, 'user:req-0001:1');
    assert.equal(parts[0].fileName, 'clipboard.png');
    assert.equal(parts[0].mimeType, 'image/png');
    assert.equal(parts[0].width, 16);
    assert.equal(parts[0].height, 9);
    assert.ok(parts[0].assetPath.endsWith('assets/user-input/req-0001/01.png'));
    assert.equal(fs.readFileSync(parts[0].filePath, 'utf8'), 'fake');

    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it('hydrates persisted user images into provider and display content', async () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qpanda-user-content-'));
    const manifest = {
      runDir,
      files: {
        userAssetsDir: path.join(runDir, 'assets', 'user-input'),
      },
    };
    const [assetPart] = await persistUserMessageAttachments(manifest, 'req-0002', [{
      fileName: 'design.png',
      mimeType: 'image/png',
      width: 32,
      height: 24,
      dataUrl: 'data:image/png;base64,ZmFrZQ==',
    }]);
    const content = buildUserMessageContent('What is wrong here?', [assetPart]);

    const providerContent = buildProviderUserContent(content);
    assert.ok(Array.isArray(providerContent));
    assert.equal(providerContent[0].type, 'text');
    assert.equal(providerContent[0].text, 'What is wrong here?');
    assert.equal(providerContent[1].type, 'image_url');
    assert.match(providerContent[1].image_url.url, /^data:image\/png;base64,/);

    const display = buildUserMessageDisplay(content);
    assert.equal(display.text, 'What is wrong here?');
    assert.equal(display.attachments.length, 1);
    assert.equal(display.attachments[0].fileName, 'design.png');
    assert.equal(display.attachments[0].width, 32);
    assert.equal(display.attachments[0].height, 24);
    assert.match(display.attachments[0].dataUrl, /^data:image\/png;base64,/);

    fs.rmSync(runDir, { recursive: true, force: true });
  });
});
