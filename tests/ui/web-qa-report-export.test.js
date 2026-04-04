const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { createWebviewDom, sampleInitConfig } = require('../helpers/webview-dom');

let wv;

beforeEach(() => {
  wv = createWebviewDom({ savedState: { currentMode: 'dev', runId: 'run-1' } });
  wv.postMessage(sampleInitConfig({ runId: 'run-1' }));
});

afterEach(() => {
  wv.cleanup();
});

describe('standalone web QA report export', () => {
  it('triggers a browser download when the host exports a PDF', () => {
    let clickedHref = null;
    let clickedDownload = null;
    const proto = wv.window.HTMLAnchorElement.prototype;
    const origClick = proto.click;
    proto.click = function click() {
      clickedHref = this.href;
      clickedDownload = this.download;
    };

    try {
      wv.postMessage({
        type: 'qaReportExported',
        url: '/exports/QA%20Report.pdf',
        fileName: 'QA Report.pdf',
      });

      assert.equal(clickedHref, 'https://webview.test/exports/QA%20Report.pdf');
      assert.equal(clickedDownload, 'QA Report.pdf');
      assert.equal(wv.document.querySelector('a[download]'), null);
    } finally {
      proto.click = origClick;
    }
  });
});
