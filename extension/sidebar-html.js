/**
 * HTML template for the QA Panda Activity Bar launcher view.
 *
 * @param {object} opts
 * @param {string} opts.styleHref
 * @param {string} opts.scriptSrc
 * @param {string} [opts.nonce]
 * @param {string} [opts.cspSource]
 */
function getSidebarHtml({ styleHref, scriptSrc, nonce, cspSource }) {
  const cspMeta = nonce
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}'; img-src ${cspSource} data:;">`
    : '';
  const scriptAttr = nonce ? ` nonce="${nonce}"` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${cspMeta}
  <link rel="stylesheet" href="${styleHref}">
  <title>QA Panda</title>
</head>
<body>
  <div class="launcher-root">
    <div class="launcher-header">
      <div>
        <div class="launcher-eyebrow">QA Panda</div>
        <div class="launcher-title">Sessions</div>
      </div>
      <button id="launcher-refresh" class="launcher-icon-btn" type="button" title="Refresh sessions" aria-label="Refresh sessions">↻</button>
    </div>

    <div class="launcher-actions">
      <button id="launcher-new-session" class="launcher-btn launcher-btn-primary" type="button">+ New session</button>
      <button id="launcher-resume-latest" class="launcher-btn" type="button">Resume latest</button>
      <button id="launcher-open-workspace" class="launcher-btn" type="button" style="display:none;">Open Workspace...</button>
    </div>

    <div class="launcher-search">
      <input id="launcher-search" class="launcher-search-input" type="text" placeholder="Search sessions..." />
    </div>

    <div id="launcher-empty" class="launcher-empty"></div>
    <div id="launcher-runs" class="launcher-runs"></div>
  </div>

  <script${scriptAttr} src="${scriptSrc}"></script>
</body>
</html>`;
}

module.exports = { getSidebarHtml };
