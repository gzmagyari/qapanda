const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const manifest = require(path.resolve(__dirname, '..', 'extension', 'package.json'));

test('extension manifest includes onWebviewPanel activation event for panel restore', () => {
  assert.ok(
    Array.isArray(manifest.activationEvents),
    'activationEvents should be an array'
  );
  assert.ok(
    manifest.activationEvents.includes('onWebviewPanel:qapandaPanel'),
    'activationEvents must include onWebviewPanel:qapandaPanel for reload-restore'
  );
});

test('extension manifest contributes the QA Panda activity bar launcher view', () => {
  assert.ok(
    manifest.activationEvents.includes('onView:qapandaLauncherView'),
    'activationEvents must include onView:qapandaLauncherView for the launcher sidebar'
  );
  assert.equal(
    manifest.contributes.viewsContainers.activitybar.some((item) => item.id === 'qapandaActivity'),
    true,
    'viewsContainers.activitybar must declare qapandaActivity'
  );
  assert.equal(
    manifest.contributes.views.qapandaActivity.some((item) => item.id === 'qapandaLauncherView'),
    true,
    'views.qapandaActivity must declare qapandaLauncherView'
  );
  assert.equal(
    manifest.contributes.views.qapandaActivity.some((item) => item.id === 'qapandaLauncherView' && item.type === 'webview'),
    true,
    'qapandaLauncherView must be declared as a webview view'
  );
});
