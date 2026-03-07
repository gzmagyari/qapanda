const path = require('node:path');
const { runManagerLoop, printRunSummary, printEventTail } = require('../src/orchestrator');
const {
  defaultStateRoot,
  listRunManifests,
  loadManifestFromDir,
  prepareNewRun,
  resolveRunDir,
  saveManifest,
} = require('../src/state');
const { summarizeError } = require('../src/utils');

class SessionManager {
  constructor(renderer, options = {}) {
    this._renderer = renderer;
    this._repoRoot = options.repoRoot || process.cwd();
    this._stateRoot = options.stateRoot || defaultStateRoot(this._repoRoot);
    this._runOptions = options.runOptions || {};
    this._activeManifest = null;
    this._abortController = null;
    this._running = false;
    this._postMessage = options.postMessage || (() => {});
  }

  get running() {
    return this._running;
  }

  async handleMessage(msg) {
    if (!msg || !msg.type) return;

    if (msg.type === 'abort') {
      this.abort();
      return;
    }

    if (msg.type === 'userInput') {
      await this._handleInput(String(msg.text || '').trim());
      return;
    }
  }

  abort() {
    if (this._abortController) {
      this._abortController.abort();
    }
  }

  async _handleInput(text) {
    if (!text) return;
    if (this._running) {
      this._renderer.banner('A request is already running. Use the stop button to abort.');
      return;
    }

    if (text.startsWith('/')) {
      await this._handleCommand(text);
      return;
    }

    // Plain text: start or continue a run
    try {
      if (!this._activeManifest) {
        this._activeManifest = await prepareNewRun(text, {
          ...this._runOptions,
          repoRoot: this._repoRoot,
          stateRoot: this._stateRoot,
        });
      }
      await this._runLoop({ userMessage: text });
    } catch (error) {
      this._renderer.banner(`Run error: ${summarizeError(error)}`);
    } finally {
      this._renderer.close();
    }
  }

  async _handleCommand(text) {
    const space = text.indexOf(' ');
    const command = space === -1 ? text : text.slice(0, space);
    const rest = space === -1 ? '' : text.slice(space + 1).trim();

    if (command === '/help') {
      this._renderer.banner(
        'Commands:\n' +
        '  /help                Show this help\n' +
        '  /new <message>       Start a new run\n' +
        '  /resume <run-id>     Attach to an existing run\n' +
        '  /run                 Continue an interrupted request\n' +
        '  /status              Show status for the attached run\n' +
        '  /list                List saved runs\n' +
        '  /logs [n]            Show the last n event lines\n' +
        '  /detach              Detach from the current run\n' +
        '\nPlain text starts a new run or continues the current one.'
      );
      return;
    }

    if (command === '/detach') {
      this._activeManifest = null;
      this._renderer.banner('Detached from the current run.');
      return;
    }

    if (command === '/list') {
      const manifests = await listRunManifests(this._stateRoot);
      if (manifests.length === 0) {
        this._renderer.banner('No runs found.');
      } else {
        for (const manifest of manifests) {
          this._renderer.banner(`${manifest.runId} | ${manifest.status} | ${manifest.transcriptSummary || ''}`);
        }
      }
      return;
    }

    if (command === '/resume' || command === '/use') {
      if (!rest) {
        this._renderer.banner('Usage: /resume <run-id>');
        return;
      }
      const runDir = await resolveRunDir(rest, this._stateRoot);
      this._activeManifest = await loadManifestFromDir(runDir);
      this._renderer.requestStarted(this._activeManifest.runId);
      return;
    }

    if (command === '/status') {
      if (!this._activeManifest) {
        this._renderer.banner('No run is attached.');
        return;
      }
      // Collect output into a string and send as banner
      const lines = [];
      const fakeOut = { write: (t) => lines.push(t) };
      await printRunSummary(this._activeManifest, fakeOut);
      this._renderer.banner(lines.join(''));
      return;
    }

    if (command === '/logs') {
      if (!this._activeManifest) {
        this._renderer.banner('No run is attached.');
        return;
      }
      const tail = rest ? Number.parseInt(rest, 10) || 40 : 40;
      const lines = [];
      const fakeOut = { write: (t) => lines.push(t) };
      await printEventTail(this._activeManifest, tail, fakeOut);
      this._renderer.banner(lines.join(''));
      return;
    }

    if (command === '/run') {
      if (!this._activeManifest) {
        this._renderer.banner('No run is attached.');
        return;
      }
      try {
        await this._runLoop({});
      } catch (error) {
        this._renderer.banner(`Run error: ${summarizeError(error)}`);
      } finally {
        this._renderer.close();
      }
      return;
    }

    if (command === '/new') {
      if (!rest) {
        this._renderer.banner('Usage: /new <message>');
        return;
      }
      this._activeManifest = await prepareNewRun(rest, {
        ...this._runOptions,
        repoRoot: this._repoRoot,
        stateRoot: this._stateRoot,
      });
      this._renderer.requestStarted(this._activeManifest.runId);
      try {
        await this._runLoop({ userMessage: rest });
      } catch (error) {
        this._renderer.banner(`Run error: ${summarizeError(error)}`);
      } finally {
        this._renderer.close();
      }
      return;
    }

    this._renderer.banner(`Unknown command: ${command}`);
  }

  async _runLoop(options) {
    this._running = true;
    this._abortController = new AbortController();
    this._postMessage({ type: 'running', value: true });

    try {
      this._activeManifest = await runManagerLoop(this._activeManifest, this._renderer, options);
      await saveManifest(this._activeManifest);
    } finally {
      this._running = false;
      this._abortController = null;
      this._postMessage({ type: 'running', value: false });
    }
  }

  dispose() {
    this.abort();
  }
}

module.exports = { SessionManager };
