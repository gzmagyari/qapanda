/**
 * HTTP wrapper for cc-tests MCP server.
 * Same pattern as tasks-mcp-http.js.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createMcpHttpServer } = require('./mcp-http-server');
const { rankSearchResults } = require('./mcp-search');

// Import tool definitions and handler from the stdio server inline
// (we duplicate the tool list and handler to keep them in sync)

const VALID_TEST_STATUSES = ['untested', 'passing', 'failing', 'partial'];
const VALID_STEP_STATUSES = ['untested', 'pass', 'fail', 'skip'];
const VALID_ENVIRONMENTS = ['browser', 'computer'];

function nowIso() { return new Date().toISOString(); }

function computeOverallStatus(steps) {
  if (!steps || steps.length === 0) return 'untested';
  const statuses = steps.map(s => s.status);
  if (statuses.every(s => s === 'untested')) return 'untested';
  if (statuses.every(s => s === 'pass' || s === 'skip')) return 'passing';
  if (statuses.every(s => s === 'fail')) return 'failing';
  if (statuses.some(s => s === 'fail')) return 'partial';
  if (statuses.some(s => s === 'pass')) return 'partial';
  return 'untested';
}

// We define the tools inline here because requiring the stdio server would auto-start it.

let _testsFile = '';
let _tasksFile = '';
let _server = null;

function loadData() {
  try { return JSON.parse(fs.readFileSync(_testsFile, 'utf8')); }
  catch { return { nextId: 1, nextStepId: 1, nextRunId: 1, tests: [] }; }
}

function saveData(data) {
  const dir = path.dirname(_testsFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(_testsFile, JSON.stringify(data, null, 2), 'utf8');
}

function loadTasksData() {
  try { return JSON.parse(fs.readFileSync(_tasksFile, 'utf8')); }
  catch { return { nextId: 1, nextCommentId: 1, nextProgressId: 1, tasks: [] }; }
}

function saveTasksData(data) {
  const dir = path.dirname(_tasksFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(_tasksFile, JSON.stringify(data, null, 2), 'utf8');
}

// Same tools as tests-mcp-server.js
const HTTP_TOOLS = [
  { name: 'list_tests', description: 'List tests, optionally filtered', inputSchema: { type: 'object', properties: { status: { type: 'string' }, environment: { type: 'string' }, tag: { type: 'string' } } } },
  { name: 'get_test', description: 'Get full test details', inputSchema: { type: 'object', properties: { test_id: { type: 'string' } }, required: ['test_id'] } },
  { name: 'search_tests', description: 'Search for likely reusable existing tests before creating a new one', inputSchema: { type: 'object', properties: { query: { type: 'string' }, environment: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'create_test', description: 'Create a new test case', inputSchema: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, environment: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['title', 'environment'] } },
  { name: 'update_test', description: 'Update test fields', inputSchema: { type: 'object', properties: { test_id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, environment: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['test_id'] } },
  { name: 'delete_test', description: 'Delete a test', inputSchema: { type: 'object', properties: { test_id: { type: 'string' } }, required: ['test_id'] } },
  { name: 'add_test_step', description: 'Add step to test', inputSchema: { type: 'object', properties: { test_id: { type: 'string' }, description: { type: 'string' }, expectedResult: { type: 'string' } }, required: ['test_id', 'description', 'expectedResult'] } },
  { name: 'update_test_step', description: 'Update step', inputSchema: { type: 'object', properties: { test_id: { type: 'string' }, step_id: { type: 'number' }, description: { type: 'string' }, expectedResult: { type: 'string' } }, required: ['test_id', 'step_id'] } },
  { name: 'delete_test_step', description: 'Delete step', inputSchema: { type: 'object', properties: { test_id: { type: 'string' }, step_id: { type: 'number' } }, required: ['test_id', 'step_id'] } },
  { name: 'run_test', description: 'Start a test run', inputSchema: { type: 'object', properties: { test_id: { type: 'string' }, agent: { type: 'string' } }, required: ['test_id'] } },
  { name: 'reset_test_steps', description: 'Reset stored step results on a test before rerunning it', inputSchema: { type: 'object', properties: { test_id: { type: 'string' }, clear_actual_results: { type: 'boolean' } }, required: ['test_id'] } },
  { name: 'update_step_result', description: 'Record step pass/fail', inputSchema: { type: 'object', properties: { test_id: { type: 'string' }, run_id: { type: 'number' }, step_id: { type: 'number' }, status: { type: 'string' }, actualResult: { type: 'string' } }, required: ['test_id', 'run_id', 'step_id', 'status'] } },
  { name: 'complete_test_run', description: 'Finalize test run', inputSchema: { type: 'object', properties: { test_id: { type: 'string' }, run_id: { type: 'number' }, notes: { type: 'string' } }, required: ['test_id', 'run_id'] } },
  { name: 'link_test_to_task', description: 'Link test to task', inputSchema: { type: 'object', properties: { test_id: { type: 'string' }, task_id: { type: 'string' } }, required: ['test_id', 'task_id'] } },
  { name: 'unlink_test_from_task', description: 'Unlink test from task', inputSchema: { type: 'object', properties: { test_id: { type: 'string' }, task_id: { type: 'string' } }, required: ['test_id', 'task_id'] } },
  { name: 'create_bug_from_test', description: 'Create bug ticket from failing test', inputSchema: { type: 'object', properties: { test_id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' } }, required: ['test_id', 'title'] } },
  { name: 'get_test_history', description: 'Get test run history', inputSchema: { type: 'object', properties: { test_id: { type: 'string' } }, required: ['test_id'] } },
  { name: 'get_test_summary', description: 'Get test suite statistics', inputSchema: { type: 'object', properties: {} } },
  { name: 'display_test_summary', description: 'Display a styled test summary card in the chat. Call this after completing a test run to show results visually.', inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'Test name' }, passed: { type: 'number', description: 'Number of passed steps' }, failed: { type: 'number', description: 'Number of failed steps' }, skipped: { type: 'number', description: 'Number of skipped steps' }, steps: { type: 'array', description: 'Individual step results', items: { type: 'object', properties: { name: { type: 'string', description: 'Step name' }, status: { type: 'string', enum: ['pass', 'fail', 'skip'], description: 'Step result: pass, fail, or skip' } }, required: ['name', 'status'] } } }, required: ['title'] } },
  { name: 'display_bug_report', description: 'Display a styled bug report card in the chat. Call this when filing a bug to show it visually.', inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'Bug title' }, task_id: { type: 'string', description: 'Task ID if already created' }, description: { type: 'string', description: 'Bug description' }, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'Bug severity' } }, required: ['title'] } },
];

// Handler — mirrors tests-mcp-server.js handleToolCall
function handleToolCall(name, args) {
  const data = loadData();
  switch (name) {
    case 'list_tests': { let tests = data.tests; if (args.status) tests = tests.filter(t => t.status === args.status); if (args.environment) tests = tests.filter(t => t.environment === args.environment); if (args.tag) tests = tests.filter(t => t.tags && t.tags.includes(args.tag)); return JSON.stringify(tests.map(t => ({ id: t.id, title: t.title, description: t.description, environment: t.environment, status: t.status, steps_count: (t.steps||[]).length, steps_passing: (t.steps||[]).filter(s=>s.status==='pass').length, tags: t.tags||[], linkedTaskIds: t.linkedTaskIds||[], lastTestedAt: t.lastTestedAt, created_at: t.created_at })), null, 2); }
    case 'get_test': { const t = data.tests.find(t=>t.id===args.test_id); return t ? JSON.stringify(t,null,2) : JSON.stringify({error:'Not found'}); }
    case 'search_tests': {
      let tests = data.tests;
      if (args.environment) tests = tests.filter(t => t.environment === args.environment);
      const matches = rankSearchResults(
        tests,
        args.query,
        (test) => ([
          { label: 'title', value: test.title, weight: 5 },
          { label: 'description', value: test.description, weight: 3 },
          { label: 'tags', value: (test.tags || []).join(' '), weight: 2 },
          { label: 'steps', value: (test.steps || []).map((step) => `${step.description} ${step.expectedResult}`).join(' '), weight: 2 },
        ]),
        args.limit || 5
      );
      return JSON.stringify(matches.map(({ item, score, matchReason }) => ({
        id: item.id,
        title: item.title,
        description: item.description,
        environment: item.environment,
        status: item.status,
        tags: item.tags || [],
        steps_count: (item.steps || []).length,
        lastTestedAt: item.lastTestedAt || null,
        linkedTaskIds: item.linkedTaskIds || [],
        match_score: score,
        match_reason: matchReason,
      })), null, 2);
    }
    case 'create_test': { const id='test-'+data.nextId++; const t={id,title:args.title,description:args.description||'',environment:VALID_ENVIRONMENTS.includes(args.environment)?args.environment:'browser',status:'untested',steps:[],linkedTaskIds:[],tags:args.tags||[],lastTestedAt:null,lastTestedBy:null,created_at:nowIso(),updated_at:nowIso(),runs:[]}; data.tests.push(t); saveData(data); return JSON.stringify(t,null,2); }
    case 'update_test': { const t=data.tests.find(t=>t.id===args.test_id); if(!t) return JSON.stringify({error:'Not found'}); if(args.title!==undefined)t.title=args.title; if(args.description!==undefined)t.description=args.description; if(args.environment!==undefined&&VALID_ENVIRONMENTS.includes(args.environment))t.environment=args.environment; if(args.tags!==undefined)t.tags=args.tags; t.updated_at=nowIso(); saveData(data); return JSON.stringify(t,null,2); }
    case 'delete_test': { data.tests=data.tests.filter(t=>t.id!==args.test_id); saveData(data); return JSON.stringify({deleted:args.test_id}); }
    case 'add_test_step': { const t=data.tests.find(t=>t.id===args.test_id); if(!t)return JSON.stringify({error:'Not found'}); const s={id:data.nextStepId++,description:args.description,expectedResult:args.expectedResult,status:'untested',actualResult:null}; t.steps.push(s); t.updated_at=nowIso(); saveData(data); return JSON.stringify(s,null,2); }
    case 'update_test_step': { const t=data.tests.find(t=>t.id===args.test_id); if(!t)return JSON.stringify({error:'Not found'}); const s=t.steps.find(s=>s.id===args.step_id); if(!s)return JSON.stringify({error:'Step not found'}); if(args.description!==undefined)s.description=args.description; if(args.expectedResult!==undefined)s.expectedResult=args.expectedResult; t.updated_at=nowIso(); saveData(data); return JSON.stringify(s,null,2); }
    case 'delete_test_step': { const t=data.tests.find(t=>t.id===args.test_id); if(!t)return JSON.stringify({error:'Not found'}); t.steps=t.steps.filter(s=>s.id!==args.step_id); t.status=computeOverallStatus(t.steps); t.updated_at=nowIso(); saveData(data); return JSON.stringify({deleted:args.step_id}); }
    case 'run_test': { const t=data.tests.find(t=>t.id===args.test_id); if(!t)return JSON.stringify({error:'Not found'}); const r={id:data.nextRunId++,date:nowIso(),agent:args.agent||'agent',status:'running',stepResults:t.steps.map(s=>({stepId:s.id,status:'untested',actualResult:null})),notes:null}; t.runs.push(r); t.lastTestedAt=r.date; t.lastTestedBy=r.agent; t.updated_at=nowIso(); saveData(data); return JSON.stringify({run_id:r.id,test_id:t.id,steps_to_test:t.steps.length},null,2); }
    case 'reset_test_steps': { const t=data.tests.find(t=>t.id===args.test_id); if(!t)return JSON.stringify({error:'Not found'}); const clearActualResults=args.clear_actual_results!==false; for (const s of (t.steps||[])) { s.status='untested'; if (clearActualResults) s.actualResult=null; } t.status='untested'; t.updated_at=nowIso(); saveData(data); return JSON.stringify({test_id:t.id,reset_steps:(t.steps||[]).length,clear_actual_results:clearActualResults,status:t.status},null,2); }
    case 'update_step_result': { const t=data.tests.find(t=>t.id===args.test_id); if(!t)return JSON.stringify({error:'Not found'}); const r=t.runs.find(r=>r.id===args.run_id); if(!r)return JSON.stringify({error:'Run not found'}); const sr=r.stepResults.find(sr=>sr.stepId===args.step_id); if(!sr)return JSON.stringify({error:'Step not in run'}); if(VALID_STEP_STATUSES.includes(args.status))sr.status=args.status; if(args.actualResult!==undefined)sr.actualResult=args.actualResult; const step=t.steps.find(s=>s.id===args.step_id); if(step){step.status=sr.status; if(args.actualResult!==undefined)step.actualResult=args.actualResult;} t.updated_at=nowIso(); saveData(data); return JSON.stringify({step_id:args.step_id,status:sr.status,_testCard:{title:t.title,test_id:t.id,passed:t.steps.filter(s=>s.status==='pass').length,failed:t.steps.filter(s=>s.status==='fail').length,skipped:t.steps.filter(s=>!s.status||s.status==='skip'||s.status==='untested').length,steps:t.steps.map(s=>({name:s.description,status:s.status==='untested'?'skip':(s.status||'skip')}))}}); }
    case 'complete_test_run': { const t=data.tests.find(t=>t.id===args.test_id); if(!t)return JSON.stringify({error:'Not found'}); const r=t.runs.find(r=>r.id===args.run_id); if(!r)return JSON.stringify({error:'Run not found'}); if(args.notes)r.notes=args.notes; const sts=r.stepResults.map(sr=>sr.status); if(sts.every(s=>s==='pass'||s==='skip'))r.status='passing'; else if(sts.every(s=>s==='fail'))r.status='failing'; else if(sts.some(s=>s==='fail'))r.status='partial'; else r.status='untested'; t.status=computeOverallStatus(t.steps); t.updated_at=nowIso(); saveData(data); return JSON.stringify({test_id:t.id,run_id:r.id,status:r.status,test_status:t.status,_testCard:{title:t.title,test_id:t.id,passed:t.steps.filter(s=>s.status==='pass').length,failed:t.steps.filter(s=>s.status==='fail').length,skipped:t.steps.filter(s=>!s.status||s.status==='skip'||s.status==='untested').length,steps:t.steps.map(s=>({name:s.description,status:s.status==='untested'?'skip':(s.status||'skip')}))}}); }
    case 'link_test_to_task': { const t=data.tests.find(t=>t.id===args.test_id); if(!t)return JSON.stringify({error:'Not found'}); if(!t.linkedTaskIds)t.linkedTaskIds=[]; if(!t.linkedTaskIds.includes(args.task_id))t.linkedTaskIds.push(args.task_id); t.updated_at=nowIso(); saveData(data); return JSON.stringify({test_id:t.id,linkedTaskIds:t.linkedTaskIds}); }
    case 'unlink_test_from_task': { const t=data.tests.find(t=>t.id===args.test_id); if(!t)return JSON.stringify({error:'Not found'}); t.linkedTaskIds=(t.linkedTaskIds||[]).filter(id=>id!==args.task_id); t.updated_at=nowIso(); saveData(data); return JSON.stringify({test_id:t.id,linkedTaskIds:t.linkedTaskIds}); }
    case 'create_bug_from_test': { const t=data.tests.find(t=>t.id===args.test_id); if(!t)return JSON.stringify({error:'Not found'}); const td=loadTasksData(); const taskId='task-'+td.nextId++; const failingSteps=t.steps.filter(s=>s.status==='fail'); const desc=args.description||`Bug from test: ${t.title}\n\nFailing steps:\n${failingSteps.map(s=>`- ${s.description}: expected "${s.expectedResult}", got "${s.actualResult||'N/A'}"`).join('\n')}`; td.tasks.push({id:taskId,title:args.title,description:desc,detail_text:'',status:'todo',created_at:nowIso(),updated_at:nowIso(),comments:[],progress_updates:[],linkedTestIds:[t.id]}); saveTasksData(td); if(!t.linkedTaskIds)t.linkedTaskIds=[]; t.linkedTaskIds.push(taskId); t.updated_at=nowIso(); saveData(data); return JSON.stringify({task_id:taskId,test_id:t.id,title:args.title},null,2); }
    case 'get_test_history': { const t=data.tests.find(t=>t.id===args.test_id); return t ? JSON.stringify(t.runs||[],null,2) : JSON.stringify({error:'Not found'}); }
    case 'get_test_summary': { const total=data.tests.length; return JSON.stringify({total,passing:data.tests.filter(t=>t.status==='passing').length,failing:data.tests.filter(t=>t.status==='failing').length,partial:data.tests.filter(t=>t.status==='partial').length,untested:data.tests.filter(t=>t.status==='untested').length},null,2); }
    case 'display_test_summary': return 'Displayed test summary card.';
    case 'display_bug_report': return 'Displayed bug report card.';
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

async function startTestsMcpServer(testsFile, tasksFile) {
  if (_server) return _server;
  _testsFile = testsFile;
  _tasksFile = tasksFile || testsFile.replace('tests.json', 'tasks.json');
  const result = await createMcpHttpServer({
    tools: HTTP_TOOLS,
    handleToolCall,
    serverName: 'cc-tests',
  });
  _server = result;
  console.error(`[cc-tests-http] Started on port ${result.port}, tests file: ${_testsFile}`);
  return result;
}

function stopTestsMcpServer() {
  if (_server) { _server.close(); _server = null; }
}

module.exports = { startTestsMcpServer, stopTestsMcpServer };
