const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { loadWorkflows: loadWorkflowsSrc } = require('../src/prompts');
const { loadWorkflows: loadWorkflowsExt } = require('../extension/src/prompts');

async function setupRepo(workflows) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cc-wf-fm-'));
  for (const { dirName, content } of workflows) {
    const wfDir = path.join(root, '.qpanda', 'workflows', dirName);
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(path.join(wfDir, 'WORKFLOW.md'), content);
  }
  return root;
}

test('folded multi-line description is fully captured (src/prompts)', async () => {
  const root = await setupRepo([{
    dirName: 'demo',
    content: '---\nname: demo\ndescription: >\n  first line\n  second line\n---\n\nbody\n',
  }]);
  const wfs = loadWorkflowsSrc(root);
  assert.equal(wfs.length, 1);
  assert.equal(wfs[0].name, 'demo');
  assert.equal(wfs[0].description, 'first line second line');
});

test('folded multi-line description is fully captured (extension/src/prompts)', async () => {
  const root = await setupRepo([{
    dirName: 'demo',
    content: '---\nname: demo\ndescription: >\n  first line\n  second line\n---\n\nbody\n',
  }]);
  const wfs = loadWorkflowsExt(root);
  assert.equal(wfs.length, 1);
  assert.equal(wfs[0].name, 'demo');
  assert.equal(wfs[0].description, 'first line second line');
});

test('single-line description still works (src/prompts)', async () => {
  const root = await setupRepo([{
    dirName: 'simple',
    content: '---\nname: simple\ndescription: A simple workflow\n---\n\nbody\n',
  }]);
  const wfs = loadWorkflowsSrc(root);
  assert.equal(wfs.length, 1);
  assert.equal(wfs[0].name, 'simple');
  assert.equal(wfs[0].description, 'A simple workflow');
});

test('single-line description still works (extension/src/prompts)', async () => {
  const root = await setupRepo([{
    dirName: 'simple',
    content: '---\nname: simple\ndescription: A simple workflow\n---\n\nbody\n',
  }]);
  const wfs = loadWorkflowsExt(root);
  assert.equal(wfs.length, 1);
  assert.equal(wfs[0].name, 'simple');
  assert.equal(wfs[0].description, 'A simple workflow');
});
