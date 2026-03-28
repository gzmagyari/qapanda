/**
 * MCP tool → visual card mapping.
 * Used by codex-worker.js and webview-renderer.js to render visual cards
 * instead of plain "Calling X / Finished X" text.
 *
 * Each entry has:
 *   icon       — emoji for the card
 *   text       — completed state text (e.g. "Screenshot captured")
 *   startText  — pending state text (e.g. "Taking screenshot...")
 *   field      — input field to show as detail (e.g. 'url', 'title')
 *   template   — special card type (testCard, command, etc.)
 *   suppress   — true to suppress normal "Calling/Finished" text entirely
 */

const CARD_MAP = {
  // ── cc-tests ──────────────────────────────
  create_test:          { icon: '\uD83D\uDC3C\uD83E\uDDEA', text: 'Test Created', startText: 'Creating test', field: 'title' },
  add_test_step:        { icon: '\uD83D\uDCDD', text: 'Step added', startText: 'Adding step', field: 'description' },
  run_test:             { icon: '\uD83D\uDC3C\uD83C\uDFC3', text: 'Test started', startText: 'Starting test run' },
  update_step_result:   { icon: '\u2705', text: 'Step result updated', startText: 'Updating step result', template: 'testCard' },
  complete_test_run:    { icon: '\uD83C\uDFC1', text: 'Test run complete', startText: 'Completing test run', template: 'testCard' },
  create_bug_from_test: { icon: '\uD83D\uDC1B', text: 'Bug Filed', startText: 'Filing bug', field: 'title' },
  get_test_summary:     { icon: '\uD83D\uDC3C\uD83D\uDCCA', text: 'Test suite summary', startText: 'Getting test summary', template: 'testSuite' },
  list_tests:           { icon: '\uD83D\uDCCB', text: 'Listed tests', startText: 'Listing tests' },
  get_test:             { icon: '\uD83D\uDD0D', text: 'Viewing test', startText: 'Loading test', field: 'test_id' },
  get_test_history:     { icon: '\uD83D\uDCDC', text: 'Test history', startText: 'Loading history', field: 'test_id' },
  display_test_summary: { template: 'displayTestSummary', suppress: true },
  display_bug_report:   { template: 'displayBugReport', suppress: true },

  // ── cc-tasks ──────────────────────────────
  create_task:          { icon: '\uD83D\uDCCB', text: 'Task Created', startText: 'Creating task', field: 'title' },
  update_task_status:   { icon: '\uD83D\uDCCB', text: 'Status changed', startText: 'Updating status', template: 'statusChange' },
  add_comment:          { icon: '\uD83D\uDCAC', text: 'Comment added', startText: 'Adding comment', template: 'comment' },
  add_progress_update:  { icon: '\uD83D\uDCCA', text: 'Progress updated', startText: 'Adding progress' },
  list_tasks:           { icon: '\uD83D\uDCCB', text: 'Listed tasks', startText: 'Listing tasks' },
  get_task:             { icon: '\uD83D\uDD0D', text: 'Viewing task', startText: 'Loading task', field: 'task_id' },
  display_task:         { template: 'displayTask', suppress: true },

  // ── Chrome DevTools ───────────────────────
  navigate_page:        { icon: '\uD83C\uDF10', text: 'Navigated to', startText: 'Navigating to', field: 'url' },
  take_screenshot:      { icon: '\uD83D\uDCF8', text: 'Screenshot captured', startText: 'Taking screenshot' },
  take_snapshot:        { icon: '\uD83D\uDCC4', text: 'DOM snapshot captured', startText: 'Taking DOM snapshot' },
  click:                { icon: '\uD83D\uDC46', text: 'Clicked', startText: 'Clicking', field: 'selector' },
  fill:                 { icon: '\u2328\uFE0F', text: 'Filled', startText: 'Filling', field: 'selector' },
  type_text:            { icon: '\u2328\uFE0F', text: 'Typed text', startText: 'Typing text' },
  evaluate_script:      { icon: '\u26A1', text: 'Ran script', startText: 'Running script' },
  hover:                { icon: '\uD83D\uDC46', text: 'Hovered', startText: 'Hovering', field: 'selector' },
  press_key:            { icon: '\u2328\uFE0F', text: 'Pressed key', startText: 'Pressing key', field: 'key' },
  fill_form:            { icon: '\uD83D\uDCDD', text: 'Filled form', startText: 'Filling form' },
  wait_for:             { icon: '\u23F3', text: 'Done waiting', startText: 'Waiting for', field: 'selector' },
  lighthouse_audit:     { icon: '\uD83D\uDD26', text: 'Lighthouse audit complete', startText: 'Running Lighthouse audit' },
  list_console_messages: { icon: '\uD83D\uDCDF', text: 'Console messages', startText: 'Getting console messages' },
  list_network_requests: { icon: '\uD83C\uDF10', text: 'Network requests', startText: 'Getting network requests' },
  get_console_message:  { icon: '\uD83D\uDCDF', text: 'Console message', startText: 'Getting console message' },
  get_network_request:  { icon: '\uD83C\uDF10', text: 'Network request', startText: 'Getting network request' },
  handle_dialog:        { icon: '\uD83D\uDCAC', text: 'Handled dialog', startText: 'Handling dialog' },
  emulate:              { icon: '\uD83D\uDCF1', text: 'Emulating device', startText: 'Setting up emulation' },
  resize_page:          { icon: '\uD83D\uDD32', text: 'Resized page', startText: 'Resizing page' },
  upload_file:          { icon: '\uD83D\uDCC1', text: 'Uploaded file', startText: 'Uploading file' },
  drag:                 { icon: '\uD83D\uDC46', text: 'Dragged element', startText: 'Dragging element' },
  take_memory_snapshot: { icon: '\uD83E\uDDE0', text: 'Memory snapshot', startText: 'Taking memory snapshot' },
  performance_start_trace: { icon: '\u23F1\uFE0F', text: 'Tracing started', startText: 'Starting performance trace' },
  performance_stop_trace:  { icon: '\u23F1\uFE0F', text: 'Trace stopped', startText: 'Stopping performance trace' },
  performance_analyze_insight: { icon: '\uD83D\uDCCA', text: 'Performance analysis', startText: 'Analyzing performance' },
  select_page:          { icon: '\uD83D\uDD17', text: 'Selected page', startText: 'Selecting page' },
  list_pages:           { icon: '\uD83D\uDD17', text: 'Listed pages', startText: 'Listing pages' },

  // ── Detached Command ──────────────────────
  start_command:        { icon: '\u25B6\uFE0F', text: 'Command started', startText: 'Running command', template: 'command', field: 'command' },
  read_output:          { icon: '\uD83D\uDCD6', text: 'Output read', startText: 'Reading output' },
  stop_job:             { icon: '\u23F9\uFE0F', text: 'Job stopped', startText: 'Stopping job' },
  list_jobs:            { icon: '\uD83D\uDCCB', text: 'Jobs listed', startText: 'Listing jobs' },
  get_job:              { icon: '\uD83D\uDD0D', text: 'Job info', startText: 'Getting job info' },

  // ── QA Desktop ────────────────────────────
  snapshot_container:   { icon: '\uD83D\uDCF8', text: 'Snapshot saved', startText: 'Saving snapshot', field: 'name' },
  list_instances:       { icon: '\uD83D\uDDA5\uFE0F', text: 'Instances listed', startText: 'Listing instances' },
  get_instance_status:  { icon: '\uD83D\uDDA5\uFE0F', text: 'Instance status', startText: 'Getting status' },

  // ── Agent Delegate ────────────────────────
  delegate_to_agent:    { icon: '\uD83D\uDD00', text: 'Delegated to', startText: 'Delegating to', field: 'agent_id' },
  list_agents:          { icon: '\uD83D\uDC65', text: 'Agents listed', startText: 'Listing agents' },

  // ── Computer Control (common) ─────────────
  click_screen:         { icon: '\uD83D\uDC46', text: 'Clicked screen', startText: 'Clicking screen' },
  press_keys:           { icon: '\u2328\uFE0F', text: 'Pressed keys', startText: 'Pressing keys' },
  scroll:               { icon: '\uD83D\uDCDC', text: 'Scrolled', startText: 'Scrolling' },
  launch_app:           { icon: '\uD83D\uDE80', text: 'Launched app', startText: 'Launching app', field: 'app' },
  activate_window:      { icon: '\uD83E\uDE9F', text: 'Activated window', startText: 'Activating window' },
  find_text:            { icon: '\uD83D\uDD0D', text: 'Found text', startText: 'Finding text', field: 'text' },
  find_ui_elements:     { icon: '\uD83D\uDD0D', text: 'Found UI elements', startText: 'Finding UI elements' },
  move_mouse:           { icon: '\uD83D\uDDB1\uFE0F', text: 'Moved mouse', startText: 'Moving mouse' },
  drag_mouse:           { icon: '\uD83D\uDC46', text: 'Dragged', startText: 'Dragging' },
  fill_text_field:      { icon: '\u2328\uFE0F', text: 'Filled text field', startText: 'Filling text field' },
  take_screenshot_with_ocr: { icon: '\uD83D\uDCF8', text: 'Screenshot with OCR', startText: 'Taking screenshot with OCR' },
  take_screenshot_with_ui_automation: { icon: '\uD83D\uDCF8', text: 'Screenshot with UI', startText: 'Taking screenshot with UI' },
  take_screenshot_full: { icon: '\uD83D\uDCF8', text: 'Full screenshot', startText: 'Taking full screenshot' },
  list_windows:         { icon: '\uD83E\uDE9F', text: 'Listed windows', startText: 'Listing windows' },
  kill_process:         { icon: '\u274C', text: 'Killed process', startText: 'Killing process' },
  get_clipboard:        { icon: '\uD83D\uDCCB', text: 'Got clipboard', startText: 'Getting clipboard' },
  set_clipboard:        { icon: '\uD83D\uDCCB', text: 'Set clipboard', startText: 'Setting clipboard' },
  wait_for_text:        { icon: '\u23F3', text: 'Text found', startText: 'Waiting for text' },
  wait_for_element:     { icon: '\u23F3', text: 'Element found', startText: 'Waiting for element' },
  wait_milliseconds:    { icon: '\u23F3', text: 'Wait complete', startText: 'Waiting' },
  capture_region_around: { icon: '\uD83D\uDCF8', text: 'Region captured', startText: 'Capturing region' },
  hover_and_capture:    { icon: '\uD83D\uDCF8', text: 'Hover captured', startText: 'Hovering and capturing' },
};

/**
 * Post a pending (started) card for a tool call.
 * @returns {boolean} true if the normal "Calling X" text should be suppressed
 */
function renderStartCard(tool, input, renderer, label, cardId) {
  if (!renderer || !renderer._post) return false;
  const cfg = CARD_MAP[tool];
  if (!cfg) return false;
  if (cfg.suppress) return true; // display_* tools — suppress silently

  const fieldVal = cfg.field && input ? input[cfg.field] : null;
  const detail = fieldVal ? String(fieldVal) : '';
  const text = cfg.startText || cfg.text || tool;
  const icon = cfg.icon || '';

  // For command template, show the command text
  if (cfg.template === 'command') {
    renderer._post({ type: 'mcpCardStart', id: cardId, label, icon: icon, text: text, detail: (input && input[cfg.field]) || '', template: 'command' });
    return true;
  }

  renderer._post({ type: 'mcpCardStart', id: cardId, label, icon: icon, text: text, detail: detail });
  return true;
}

/**
 * Post a completed card for a tool call (updates the pending card).
 * @returns {boolean} true if the normal "Finished X" text should be suppressed
 */
function renderCompleteCard(tool, input, output, renderer, label, cardId) {
  if (!renderer || !renderer._post) return false;
  const cfg = CARD_MAP[tool];
  if (!cfg) return false;

  // Special templates that render full cards
  if (cfg.template === 'testCard') {
    if (output && output._testCard) {
      renderer._post({ type: 'testCard', label, data: output._testCard });
    }
    // Still update the pending card to completed
    renderer._post({ type: 'mcpCardComplete', id: cardId, label, icon: cfg.icon || '', text: cfg.text || tool, detail: '' });
    return true;
  }
  if (cfg.template === 'displayTestSummary') {
    renderer._post({ type: 'testCard', label, data: input });
    return true;
  }
  if (cfg.template === 'displayBugReport') {
    renderer._post({ type: 'bugCard', label, data: input });
    return true;
  }
  if (cfg.template === 'displayTask') {
    renderer._post({ type: 'taskCard', label, data: input });
    return true;
  }
  if (cfg.template === 'testSuite') {
    renderer._post({ type: 'mcpCard', label, card: 'testSuite', data: output || {} });
    renderer._post({ type: 'mcpCardComplete', id: cardId, label, remove: true });
    return true;
  }
  if (cfg.template === 'comment') {
    renderer._post({ type: 'mcpCard', label, card: 'taskComment', data: { author: (output && output.author) || 'agent', text: (input && input.text) || '' } });
    renderer._post({ type: 'mcpCardComplete', id: cardId, label, remove: true });
    return true;
  }
  if (cfg.template === 'statusChange') {
    renderer._post({ type: 'mcpCard', label, card: 'taskStatus', data: { title: (input && input.task_id) || '', status: (input && input.status) || '' } });
    renderer._post({ type: 'mcpCardComplete', id: cardId, label, remove: true });
    return true;
  }

  // Default: update the pending card to completed state
  const fieldVal = cfg.field && input ? input[cfg.field] : null;
  const detail = fieldVal ? String(fieldVal) : '';
  if (cfg.template === 'command') {
    renderer._post({ type: 'mcpCardComplete', id: cardId, label, icon: cfg.icon || '', text: cfg.text || tool, detail: (input && input[cfg.field]) || '', template: 'command' });
  } else {
    renderer._post({ type: 'mcpCardComplete', id: cardId, label, icon: cfg.icon || '', text: cfg.text || tool, detail: detail });
  }
  return true;
}

// Keep the old function for Claude workers (single event, no transition)
function tryRenderMcpCard(tool, input, output, renderer, label) {
  if (!renderer || !renderer._post) return false;
  const cfg = CARD_MAP[tool];
  if (!cfg) return false;
  // Reuse renderCompleteCard logic but with a random ID (no pending card to update)
  return renderCompleteCard(tool, input, output, renderer, label, 'claude-' + Date.now());
}

module.exports = { CARD_MAP, tryRenderMcpCard, renderStartCard, renderCompleteCard };
