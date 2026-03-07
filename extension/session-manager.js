const path = require('node:path');
const { runManagerLoop, printRunSummary, printEventTail } = require('./src/orchestrator');
const {
  defaultStateRoot,
  listRunManifests,
  loadManifestFromDir,
  prepareNewRun,
  resolveRunDir,
  saveManifest,
} = require('./src/state');
const { summarizeError } = require('./src/utils');

const CODEX_MODELS = [
  { value: 'gpt-5.4', label: 'GPT-5.4' },
  { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' },
  { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
];

const CLAUDE_MODELS = [
  { value: 'sonnet', label: 'Sonnet (latest)' },
  { value: 'opus', label: 'Opus (latest)' },
  { value: 'haiku', label: 'Haiku' },
];

const CODEX_THINKING = [
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra High' },
];

const CLAUDE_THINKING = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

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
    // Model/thinking overrides (load from persisted config if available)
    const init = options.initialConfig || {};
    this._controllerModel = init.controllerModel || null;
    this._workerModel = init.workerModel || null;
    this._controllerThinking = init.controllerThinking || null;
    this._workerThinking = init.workerThinking || null;
  }

  applyConfig(config) {
    if (!config) return;
    this._controllerModel = config.controllerModel || null;
    this._workerModel = config.workerModel || null;
    this._controllerThinking = config.controllerThinking || null;
    this._workerThinking = config.workerThinking || null;
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
        const opts = {
          ...this._runOptions,
          repoRoot: this._repoRoot,
          stateRoot: this._stateRoot,
        };
        if (this._controllerModel) opts.controllerModel = this._controllerModel;
        if (this._workerModel) opts.workerModel = this._workerModel;
        if (this._controllerThinking) {
          opts.controllerConfig = [
            ...(opts.controllerConfig || []),
            `model_reasoning_effort="${this._controllerThinking}"`,
          ];
        }
        this._activeManifest = await prepareNewRun(text, opts);
      }
      // Apply worker thinking as env var
      if (this._workerThinking) {
        process.env.CLAUDE_CODE_EFFORT_LEVEL = this._workerThinking;
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
        '  /help                          Show this help\n' +
        '  /new <message>                 Start a new run\n' +
        '  /resume <run-id>               Attach to an existing run\n' +
        '  /run                           Continue an interrupted request\n' +
        '  /status                        Show status for the attached run\n' +
        '  /list                          List saved runs\n' +
        '  /logs [n]                      Show the last n event lines\n' +
        '  /clear                         Clear chat and start fresh\n' +
        '  /detach                        Detach from the current run\n' +
        '  /controller-model [name]       Set/show Codex model\n' +
        '  /worker-model [name]           Set/show Claude model\n' +
        '  /controller-thinking [level]   Set/show Codex thinking tier\n' +
        '  /worker-thinking [level]       Set/show Claude thinking level\n' +
        '  /config                        Show current model/thinking config\n' +
        '\nPlain text starts a new run or continues the current one.'
      );
      return;
    }

    if (command === '/clear') {
      this._activeManifest = null;
      this._postMessage({ type: 'clear' });
      this._renderer.banner('Session cleared.');
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

    if (command === '/controller-model') {
      if (!rest) {
        const current = this._controllerModel || (this._activeManifest && this._activeManifest.controller.model) || '(default)';
        const options = CODEX_MODELS.map(m => `  ${m.value} - ${m.label}`).join('\n');
        this._renderer.banner(`Controller model: ${current}\n\nAvailable:\n${options}\n  <custom> - Any model name`);
        return;
      }
      this._controllerModel = rest;
      if (this._activeManifest) {
        this._activeManifest.controller.model = rest;
      }
      this._renderer.banner(`Controller model set to: ${rest}`);
      this._syncConfig();
      return;
    }

    if (command === '/worker-model') {
      if (!rest) {
        const current = this._workerModel || (this._activeManifest && this._activeManifest.worker.model) || '(default)';
        const options = CLAUDE_MODELS.map(m => `  ${m.value} - ${m.label}`).join('\n');
        this._renderer.banner(`Worker model: ${current}\n\nAvailable:\n${options}\n  <custom> - Any model name`);
        return;
      }
      this._workerModel = rest;
      if (this._activeManifest) {
        this._activeManifest.worker.model = rest;
      }
      this._renderer.banner(`Worker model set to: ${rest}`);
      this._syncConfig();
      return;
    }

    if (command === '/controller-thinking') {
      if (!rest) {
        const current = this._controllerThinking || '(default)';
        const options = CODEX_THINKING.map(t => `  ${t.value} - ${t.label}`).join('\n');
        this._renderer.banner(`Controller thinking: ${current}\n\nAvailable:\n${options}`);
        return;
      }
      this._controllerThinking = rest;
      if (this._activeManifest) {
        // Remove any existing reasoning effort config entries
        this._activeManifest.controller.config = (this._activeManifest.controller.config || [])
          .filter(c => !c.startsWith('model_reasoning_effort='));
        this._activeManifest.controller.config.push(`model_reasoning_effort="${rest}"`);
      }
      this._renderer.banner(`Controller thinking set to: ${rest}`);
      this._syncConfig();
      return;
    }

    if (command === '/worker-thinking') {
      if (!rest) {
        const current = this._workerThinking || '(default)';
        const options = CLAUDE_THINKING.map(t => `  ${t.value} - ${t.label}`).join('\n');
        this._renderer.banner(`Worker thinking: ${current}\n\nAvailable:\n${options}`);
        return;
      }
      this._workerThinking = rest;
      this._renderer.banner(`Worker thinking set to: ${rest}`);
      this._syncConfig();
      return;
    }

    if (command === '/config') {
      const cm = this._controllerModel || (this._activeManifest && this._activeManifest.controller.model) || '(default)';
      const wm = this._workerModel || (this._activeManifest && this._activeManifest.worker.model) || '(default)';
      const ct = this._controllerThinking || '(default)';
      const wt = this._workerThinking || '(default)';
      this._renderer.banner(
        `Current config:\n` +
        `  Controller model:    ${cm}\n` +
        `  Controller thinking: ${ct}\n` +
        `  Worker model:        ${wm}\n` +
        `  Worker thinking:     ${wt}`
      );
      return;
    }

    this._renderer.banner(`Unknown command: ${command}`);
  }

  _getConfig() {
    return {
      controllerModel: this._controllerModel || '',
      workerModel: this._workerModel || '',
      controllerThinking: this._controllerThinking || '',
      workerThinking: this._workerThinking || '',
    };
  }

  _syncConfig() {
    this._postMessage({ type: 'syncConfig', config: this._getConfig() });
  }

  async _runLoop(options) {
    this._running = true;
    this._abortController = new AbortController();
    this._postMessage({ type: 'running', value: true });

    try {
      this._activeManifest = await runManagerLoop(this._activeManifest, this._renderer, {
        ...options,
        abortSignal: this._abortController.signal,
      });
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
