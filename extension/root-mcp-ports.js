const path = require('node:path');

async function ensureRootMcpPorts(root, services) {
  const repoRoot = path.resolve(root);
  const tasksFile = path.join(repoRoot, '.qpanda', 'tasks.json');
  const testsFile = path.join(repoRoot, '.qpanda', 'tests.json');
  const memoryFile = path.join(repoRoot, '.qpanda', 'MEMORY.md');

  const [tasks, tests, memory] = await Promise.all([
    services.startTasksMcpServer(tasksFile),
    services.startTestsMcpServer(testsFile, tasksFile),
    services.startMemoryMcpServer(memoryFile),
  ]);

  let qaDesktop = null;
  if (services.enableQaDesktop && typeof services.startQaDesktopMcpServer === 'function') {
    try {
      qaDesktop = await services.startQaDesktopMcpServer(repoRoot);
    } catch (error) {
      if (typeof services.onQaDesktopError === 'function') {
        try { services.onQaDesktopError(error); } catch {}
      }
    }
  }

  return {
    tasksPort: tasks && tasks.port ? tasks.port : null,
    testsPort: tests && tests.port ? tests.port : null,
    memoryPort: memory && memory.port ? memory.port : null,
    qaDesktopPort: qaDesktop && qaDesktop.port ? qaDesktop.port : null,
  };
}

module.exports = { ensureRootMcpPorts };
