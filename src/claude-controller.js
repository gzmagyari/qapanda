const { writeText, parsePossiblyFencedJson, randomId } = require('./utils');
const { spawnStreamingProcess } = require('./process-utils');
const { parseJsonLine, extractTextFromClaudeContent } = require('./events');
const { buildControllerPrompt } = require('./prompts');
const { validateControllerDecision } = require('./schema');

function buildClaudeControllerArgs(manifest, loop) {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
  ];

  if (manifest.controller.sessionId) {
    args.push('--resume', manifest.controller.sessionId);
  } else {
    // Generate a proper UUID for the initial session (Claude CLI requires valid UUIDs)
    if (!manifest.controller.claudeSessionId) {
      manifest.controller.claudeSessionId = randomId();
    }
    args.push('--session-id', manifest.controller.claudeSessionId);
  }

  if (manifest.controller.model) {
    args.push('--model', manifest.controller.model);
  }

  return args;
}

async function runClaudeControllerTurn({ manifest, request, loop, renderer, emitEvent, abortSignal }) {
  const prompt = buildControllerPrompt(manifest, request);
  await writeText(loop.controller.promptFile, `${prompt}\n`);

  const args = buildClaudeControllerArgs(manifest, loop);
  let discoveredSessionId = manifest.controller.sessionId;

  let accumulatedText = '';
  let lastAssistantMessage = '';
  let finalResultText = '';
  let sawTextDelta = false;

  const result = await spawnStreamingProcess({
    command: manifest.controller.bin,
    args,
    cwd: manifest.repoRoot,
    stdinText: prompt,
    abortSignal,
    onStdoutLine: (line) => {
      const raw = parseJsonLine(line);
      Promise.resolve(emitEvent({
        ts: new Date().toISOString(),
        source: 'controller-json',
        requestId: request.id,
        loopIndex: loop.index,
        rawLine: line,
        parsed: raw,
      })).catch(() => {});

      if (!raw) {
        renderer.controller(`(unparsed claude-controller line) ${line}`);
        return;
      }

      // Discover session ID from system event
      if (raw.session_id) {
        discoveredSessionId = raw.session_id;
      }

      // Accumulate text from streaming deltas
      if (raw.type === 'stream_event') {
        const event = raw.event || {};
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          if (!sawTextDelta && event.delta.text) {
            event.delta.text = event.delta.text.replace(/^\n+/, '');
          }
          accumulatedText += event.delta.text || '';
          sawTextDelta = true;
        }
      }

      if (raw.type === 'assistant_message' || raw.type === 'assistant') {
        const text = extractTextFromClaudeContent(raw.message?.content || raw.content);
        if (text) lastAssistantMessage = text;
      }

      if (raw.type === 'result_message' || raw.type === 'result') {
        if (typeof raw.result === 'string') {
          finalResultText = raw.result;
        } else if (typeof raw.result?.text === 'string') {
          finalResultText = raw.result.text;
        } else {
          finalResultText = extractTextFromClaudeContent(raw.message?.content || raw.content);
        }
      }

      // Render controller events — use controllerEvent for streaming events,
      // skip assistant/result if we have text deltas (same logic as claude.js worker)
      if ((raw.type === 'assistant_message' || raw.type === 'assistant') && sawTextDelta) {
        return;
      }
      if ((raw.type === 'result_message' || raw.type === 'result') && sawTextDelta) {
        renderer.flushStream();
        return;
      }

      // Render as controller activity (not worker)
      renderer.claudeControllerEvent(raw);
    },
    onStderrLine: (line) => {
      Promise.resolve(emitEvent({
        ts: new Date().toISOString(),
        source: 'controller-stderr',
        requestId: request.id,
        loopIndex: loop.index,
        text: line,
      })).catch(() => {});
      if (!manifest.settings.quiet) {
        renderer.controller(line);
      }
    },
  });

  loop.controller.exitCode = result.code;
  loop.controller.sessionId = discoveredSessionId;
  manifest.controller.sessionId = discoveredSessionId;

  if (result.aborted) {
    throw new Error('Claude controller process was interrupted.');
  }

  if (result.code !== 0) {
    throw new Error(`Claude controller exited with code ${result.code}. See ${loop.controller.stderrFile}`);
  }

  // Parse the final text as controller decision JSON
  const rawText = finalResultText || lastAssistantMessage || accumulatedText || '';
  const decision = validateControllerDecision(parsePossiblyFencedJson(rawText));
  loop.controller.decision = decision;
  request.latestControllerDecision = decision;

  return {
    prompt,
    decision,
    sessionId: discoveredSessionId,
  };
}

module.exports = {
  buildClaudeControllerArgs,
  runClaudeControllerTurn,
};
