const { parseCanonicalToolResult } = require('./tool-result-normalizer');

function baseToolName(fullToolName) {
  if (!fullToolName) return '';
  const parts = String(fullToolName).split('__');
  return parts.length >= 2 ? parts[parts.length - 1] : String(fullToolName);
}

function truncate(text, max = 120) {
  const value = String(text || '').trim().replace(/\s+/g, ' ');
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function fallbackText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result !== 'object') return String(result);
  if (!Array.isArray(result.content)) return JSON.stringify(result);
  return result.content.map((block) => {
    if (!block || typeof block !== 'object') return '';
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
    if (block.type === 'image' && block.data) return `[Screenshot captured: ${block.mimeType || 'image/png'}]`;
    return JSON.stringify(block);
  }).filter(Boolean).join('\n');
}

function stepCountText(card) {
  if (!card || typeof card !== 'object') return '';
  return `${Number(card.passed || 0)} pass, ${Number(card.failed || 0)} fail, ${Number(card.skipped || 0)} skip`;
}

function summarizeSearchResults(kind, parsed) {
  if (!Array.isArray(parsed)) return '';
  if (parsed.length === 0) return `No matching ${kind} found.`;
  const preview = parsed.slice(0, 5).map((item) => {
    const id = item && item.id ? String(item.id) : '?';
    const title = truncate(item && item.title ? item.title : '', 60);
    const status = item && item.status ? ` [${item.status}]` : '';
    const score = item && item.match_score != null ? ` score=${item.match_score}` : '';
    return `${id} "${title}"${status}${score}`;
  }).join('; ');
  return `Found ${parsed.length} ${kind}: ${preview}`;
}

function summarizeGetTest(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
  const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
  const preview = steps.slice(0, 12).map((step) => {
    const id = step && step.id != null ? `${step.id}.` : '';
    return `${id}${truncate(step && step.description ? step.description : '', 50)} [${step && step.status ? step.status : 'untested'}]`;
  }).join('; ');
  const stepSuffix = steps.length > 12 ? `; ... +${steps.length - 12} more` : '';
  const linked = Array.isArray(parsed.linkedTaskIds) && parsed.linkedTaskIds.length
    ? ` linked=${parsed.linkedTaskIds.join(',')}`
    : '';
  return `${parsed.id || 'test'} "${truncate(parsed.title, 80)}" [${parsed.status || 'untested'}] env=${parsed.environment || 'browser'} steps=${steps.length}${linked}${preview ? ` :: ${preview}${stepSuffix}` : ''}`;
}

function summarizeGetTask(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
  const comments = Array.isArray(parsed.comments) ? parsed.comments.length : 0;
  const progress = Array.isArray(parsed.progress_updates) ? parsed.progress_updates.length : 0;
  const linked = Array.isArray(parsed.linkedTestIds) && parsed.linkedTestIds.length
    ? ` linked=${parsed.linkedTestIds.join(',')}`
    : '';
  return `${parsed.id || 'task'} "${truncate(parsed.title, 80)}" [${parsed.status || 'todo'}] comments=${comments} progress=${progress}${linked}${parsed.description ? ` :: ${truncate(parsed.description, 120)}` : ''}`;
}

function summarizeUpdateStepResult(input, parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  const card = parsed._testCard;
  const counts = stepCountText(card);
  const stepId = parsed.step_id != null ? parsed.step_id : input && input.step_id;
  const status = parsed.status || (input && input.status) || 'updated';
  if (card && card.test_id) {
    return `Step ${stepId} ${status}. Test ${card.test_id}: ${counts}.`;
  }
  return `Step ${stepId} ${status}.`;
}

function summarizeRunResult(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  const counts = stepCountText(parsed._testCard);
  return `Run ${parsed.run_id || '?'} for ${parsed.test_id || 'test'} ${parsed.status || 'updated'}; test=${parsed.test_status || 'unknown'}${counts ? `; ${counts}` : ''}.`;
}

function summarizeTestStepsBatch(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  return `Test ${parsed.test_id || 'test'} steps updated: ${Number(parsed.added || 0)} added, ${Number(parsed.updated || 0)} updated, ${Number(parsed.deleted || 0)} deleted.`;
}

function summarizeTaskBatch(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  return `Task ${parsed.task_id || 'task'} updated${parsed.status ? ` [${parsed.status}]` : ''}: ${Number(parsed.fields_updated || 0)} fields, ${Number(parsed.comments_added || 0)} comments, ${Number(parsed.progress_updates_added || 0)} progress updates.`;
}

function summarizeBatch(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  const calls = Array.isArray(parsed.calls) ? parsed.calls : [];
  const ok = calls.filter((call) => call && call.ok).length;
  const failed = calls.length - ok;
  const head = `Batch executed ${ok}/${calls.length} calls${failed ? ` with ${failed} failure${failed === 1 ? '' : 's'}` : ''}.`;
  const details = calls.slice(0, 8).map((call) => {
    const tool = call && call.tool ? call.tool : 'tool';
    if (call && call.ok) {
      return `${tool}: ${truncate(call.summary || 'ok', 80)}`;
    }
    return `${tool}: ${truncate(call && call.error ? call.error : 'error', 80)}`;
  });
  return details.length > 0 ? `${head} ${details.join(' | ')}` : head;
}

function summarizeToolResultForModel(toolName, input, result) {
  const base = baseToolName(toolName);
  const parsed = parseCanonicalToolResult(result);

  if (base === 'search_tests') return summarizeSearchResults('tests', parsed) || fallbackText(result);
  if (base === 'search_tasks') return summarizeSearchResults('tasks', parsed) || fallbackText(result);
  if (base === 'get_test') return summarizeGetTest(parsed) || fallbackText(result);
  if (base === 'get_task') return summarizeGetTask(parsed) || fallbackText(result);
  if (base === 'update_step_result') return summarizeUpdateStepResult(input, parsed) || fallbackText(result);
  if (base === 'complete_test_run' || base === 'record_test_run') return summarizeRunResult(parsed) || fallbackText(result);
  if (base === 'update_test_steps_batch') return summarizeTestStepsBatch(parsed) || fallbackText(result);
  if (base === 'update_task_batch') return summarizeTaskBatch(parsed) || fallbackText(result);
  if (base === 'display_test_summary') return 'Displayed test summary card.';
  if (base === 'display_bug_report') return 'Displayed bug report card.';
  if (base === 'display_task') return 'Displayed task card.';
  if (base === 'mcp_batch') return summarizeBatch(parsed) || fallbackText(result);
  return fallbackText(result);
}

module.exports = {
  baseToolName,
  summarizeToolResultForModel,
};
