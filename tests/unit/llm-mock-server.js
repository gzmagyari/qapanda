/**
 * Mock OpenAI-compatible API server for testing the LLM client.
 * Supports streaming (SSE) and non-streaming modes, tool_calls, errors.
 */
const http = require('node:http');

/**
 * Create a mock server that responds to /v1/chat/completions.
 * @param {object} opts
 * @param {function} opts.handler - (req, body) => response config
 * @returns {{ server, port, url, close }}
 */
function createMockServer(opts = {}) {
  let _handler = opts.handler || defaultHandler;
  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const config = _handler(req, parsed);
        if (config.error) {
          res.writeHead(config.status || 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: config.error, type: config.errorType || 'server_error' } }));
          return;
        }
        if (parsed.stream) {
          sendStreamResponse(res, config);
        } else {
          sendNonStreamResponse(res, config);
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: e.message } }));
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
        setHandler: (h) => { _handler = h; },
      });
    });
  });
}

function defaultHandler(_req, _body) {
  return { text: 'Hello from mock server!' };
}

/** Send a streaming SSE response */
function sendStreamResponse(res, config) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const chunks = [];

  // Text chunks
  if (config.text) {
    const words = config.text.split(' ');
    for (const word of words) {
      chunks.push(makeChunk({ content: (chunks.length > 0 ? ' ' : '') + word }));
    }
  }

  // Tool call chunks
  if (config.toolCalls) {
    for (let i = 0; i < config.toolCalls.length; i++) {
      const tc = config.toolCalls[i];
      // First chunk: id + name
      chunks.push(makeChunk({
        toolCall: { index: i, id: tc.id || `call_${i}`, function: { name: tc.name, arguments: '' } },
      }));
      // Argument chunks (split into small pieces)
      const argsStr = JSON.stringify(tc.arguments || {});
      const chunkSize = 20;
      for (let j = 0; j < argsStr.length; j += chunkSize) {
        chunks.push(makeChunk({
          toolCall: { index: i, function: { arguments: argsStr.slice(j, j + chunkSize) } },
        }));
      }
    }
  }

  // Final chunk with finish_reason
  const finishReason = config.toolCalls ? 'tool_calls' : 'stop';
  chunks.push(makeChunk({ finishReason }));

  // Send chunks with small delays
  let idx = 0;
  const interval = setInterval(() => {
    if (idx < chunks.length) {
      res.write(`data: ${JSON.stringify(chunks[idx])}\n\n`);
      idx++;
    } else {
      // Usage chunk
      if (config.usage !== false) {
        const usageChunk = {
          id: 'chatcmpl-mock',
          object: 'chat.completion.chunk',
          choices: [],
          usage: config.usage || { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        };
        res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
      clearInterval(interval);
    }
  }, config.chunkDelay || 1);
}

/** Send a non-streaming JSON response */
function sendNonStreamResponse(res, config) {
  const message = { role: 'assistant', content: config.text || '' };
  if (config.toolCalls) {
    message.tool_calls = config.toolCalls.map((tc, i) => ({
      id: tc.id || `call_${i}`,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments || {}) },
    }));
  }
  const response = {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    choices: [{ index: 0, message, finish_reason: config.toolCalls ? 'tool_calls' : 'stop' }],
    usage: config.usage || { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(response));
}

/** Build a single streaming chunk */
function makeChunk({ content, toolCall, finishReason }) {
  const delta = {};
  if (content !== undefined) delta.content = content;
  if (toolCall) delta.tool_calls = [toolCall];
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    choices: [{
      index: 0,
      delta,
      finish_reason: finishReason || null,
    }],
  };
}

module.exports = { createMockServer };
