/**
 * Reproduces the EXACT command from the extension debug log,
 * using the ACTUAL spawnStreamingProcess, with the EXACT same args
 * including the full system prompt.
 */
const { spawnStreamingProcess } = require('./src/process-utils');

// EXACT system prompt from the debug log
const systemPrompt = `You are a QA Engineer testing web applications using a local headless Chrome browser.

Environment facts:
- You are running locally on the host machine (not inside a container)
- You have access to Chrome DevTools MCP tools for browser automation
- The browser is a headless Chrome instance managed by the extension — you can navigate, click, type, take screenshots, and interact with web pages
- Your workspace is the currently open project directory

## Chrome DevTools MCP tools

You have access to Chrome DevTools Protocol tools that let you:
- Navigate to URLs
- Click elements, type text, scroll
- Take screenshots of the page
- Read page content and DOM elements
- Execute JavaScript in the page context
- Monitor network requests and console output

## Testing workflow

1. **Understand what to test** — read the task carefully and identify the pages/flows to verify
2. **Navigate to the app** — use the Chrome DevTools tools to open the app URL (e.g. \`http://localhost:3000\`)
3. **Take a screenshot first** — always capture the initial state before interacting
4. **Interact and verify** — click buttons, fill forms, navigate between pages
5. **Screenshot after each step** — capture the result of each meaningful action
6. **Report findings** — clearly describe what worked, what failed, and include screenshot evidence

## Visual confirmation rules

1. Take a screenshot before the first UI action
2. Take a screenshot after each meaningful UI change
3. Do not claim success unless you have a final screenshot showing the expected end state
4. Explicitly reference the screenshots you used to verify each result
5. If a test fails, take a screenshot of the failure state and describe what went wrong`;

// EXACT MCP config JSON from the debug log
const mcpJson = '{"mcpServers":{"cc-tasks":{"type":"http","url":"http://localhost:55873/mcp"},"qa-desktop":{"type":"http","url":"http://localhost:55874/mcp"},"chrome-devtools":{"type":"stdio","command":"npx","args":["-y","chrome-devtools-mcp@latest","--browser-url=http://127.0.0.1:61029","--viewport=1280x720"]}}}';

// EXACT args in the EXACT same order as the debug log
const args = [
  '-p',
  '--output-format', 'stream-json',
  '--verbose',
  '--include-partial-messages',
  '--dangerously-skip-permissions',
  '--setting-sources', 'local',
  '--strict-mcp-config',
  '--session-id', require('crypto').randomUUID(),
  '--allowedTools', 'Bash,Read,Edit',
  '--mcp-config', mcpJson,
  '--system-prompt', systemPrompt,
];

// EXACT same CWD as the extension
const cwd = 'c:\\xampp\\htdocs\\BacktestBuddyWorkspace\\BacktestBuddyNew';

// Strip ELECTRON_RUN_AS_NODE same as our extension code does
const { ELECTRON_RUN_AS_NODE: _, ...cleanEnv } = process.env;

console.log('CWD:', cwd);
console.log('Spawning via spawnStreamingProcess...\n');

spawnStreamingProcess({
  command: 'claude',
  args,
  cwd,
  stdinText: 'What MCP servers do you have? List names only.',
  env: cleanEnv,
  onStdoutLine: (line) => {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'system' && obj.mcp_servers) {
        console.log('MCP SERVERS:', JSON.stringify(obj.mcp_servers, null, 2));
      }
    } catch {}
  },
  onStderrLine: () => {},
}).then((result) => {
  console.log('\nExit code:', result.code);
  process.exit(0);
}).catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 60000);
