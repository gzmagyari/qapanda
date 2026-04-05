async function callSafely(label, fn) {
  if (typeof fn !== 'function') return;
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      await result;
    }
  } catch (error) {
    console.error(`[ext] ${label} failed:`, error);
  }
}

async function cleanupPanelSession({
  repoRoot,
  panelId,
  session,
  instanceName,
  stopInstance,
  clearPanel,
  killChrome,
}) {
  if (repoRoot && panelId && typeof instanceName === 'function' && typeof stopInstance === 'function') {
    const name = instanceName(repoRoot, panelId);
    await callSafely(`stop instance ${name}`, () => stopInstance(name));
  }
  if (repoRoot && panelId && typeof clearPanel === 'function') {
    await callSafely(`clear panel ${panelId}`, () => clearPanel(panelId));
  }
  if (panelId && typeof killChrome === 'function') {
    await callSafely(`kill chrome ${panelId}`, () => killChrome(panelId));
  }
  if (session && typeof session.dispose === 'function') {
    await callSafely('dispose session', () => session.dispose());
  }
}

async function shutdownExtensionResources({
  stopTasksMcpServer,
  stopTestsMcpServer,
  stopMemoryMcpServer,
  stopQaDesktopMcpServer,
  killAll,
  closeAllConnections,
}) {
  await callSafely('stop tasks MCP', stopTasksMcpServer);
  await callSafely('stop tests MCP', stopTestsMcpServer);
  await callSafely('stop memory MCP', stopMemoryMcpServer);
  await callSafely('stop qa-desktop MCP', stopQaDesktopMcpServer);
  await callSafely('kill all chrome', killAll);
  await callSafely('close app-server connections', closeAllConnections);
}

module.exports = {
  callSafely,
  cleanupPanelSession,
  shutdownExtensionResources,
};
