const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { createWebviewDom, sampleInitConfig } = require('../helpers/webview-dom');

let wv;

beforeEach(() => {
  wv = createWebviewDom({ savedState: { runId: 'run-1' } });
  wv.postMessage(sampleInitConfig({ runId: 'run-1' }));
});

afterEach(() => {
  wv.cleanup();
});

describe('Review button', () => {
  it('is hidden until the host reports reviewable git changes', async () => {
    await wv.flush();
    const reviewSplit = wv.document.getElementById('review-split');
    assert.equal(reviewSplit.style.display, 'none');

    wv.postMessage({
      type: 'reviewState',
      reviewState: {
        visible: true,
        isGitRepo: true,
        hasUnstaged: true,
        hasStaged: false,
        defaultScope: 'unstaged',
        unstagedCount: 2,
        stagedCount: 0,
      },
    });
    await wv.flush();

    assert.equal(reviewSplit.style.display, 'inline-flex');
  });

  it('main review click sends a reviewRequest with optional guidance', async () => {
    wv.postMessage({
      type: 'reviewState',
      reviewState: {
        visible: true,
        isGitRepo: true,
        hasUnstaged: true,
        hasStaged: false,
        defaultScope: 'unstaged',
        unstagedCount: 1,
        stagedCount: 0,
      },
    });
    await wv.flush();

    const input = wv.document.getElementById('user-input');
    input.value = 'Focus on auth edge cases';
    wv.document.getElementById('btn-review').click();

    const reviewMsg = wv.messages.filter((msg) => msg.type === 'reviewRequest').at(-1);
    assert.equal(reviewMsg.type, 'reviewRequest');
    assert.equal(reviewMsg.scope, 'unstaged');
    assert.equal(reviewMsg.guidance, 'Focus on auth edge cases');
    assert.equal(input.value, '');
  });

  it('review menu enables only the available scopes', async () => {
    wv.postMessage({
      type: 'reviewState',
      reviewState: {
        visible: true,
        isGitRepo: true,
        hasUnstaged: true,
        hasStaged: true,
        defaultScope: 'unstaged',
        unstagedCount: 3,
        stagedCount: 2,
      },
    });
    await wv.flush();

    wv.document.getElementById('btn-review-menu').click();

    const unstaged = wv.document.querySelector('.split-action-item[data-scope="unstaged"]');
    const staged = wv.document.querySelector('.split-action-item[data-scope="staged"]');
    const both = wv.document.querySelector('.split-action-item[data-scope="both"]');

    assert.equal(unstaged.disabled, false);
    assert.equal(staged.disabled, false);
    assert.equal(both.disabled, false);

    staged.click();
    const reviewMsg = wv.messages.filter((msg) => msg.type === 'reviewRequest').at(-1);
    assert.equal(reviewMsg.scope, 'staged');
  });

  it('review dropdown opens and updates aria state when the chevron is clicked', async () => {
    wv.postMessage({
      type: 'reviewState',
      reviewState: {
        visible: true,
        isGitRepo: true,
        hasUnstaged: true,
        hasStaged: true,
        defaultScope: 'unstaged',
        unstagedCount: 3,
        stagedCount: 2,
      },
    });
    await wv.flush();

    const menuBtn = wv.document.getElementById('btn-review-menu');
    const menu = wv.document.getElementById('review-menu');
    const split = wv.document.getElementById('review-split');

    assert.equal(menu.style.display, 'none');
    assert.equal(menuBtn.getAttribute('aria-expanded'), 'false');

    menuBtn.click();

    assert.equal(menu.style.display, 'block');
    assert.equal(menuBtn.getAttribute('aria-expanded'), 'true');
    assert.ok(split.classList.contains('menu-open'));
  });
});
