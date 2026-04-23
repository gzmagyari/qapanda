(function () {
  const vscode = acquireVsCodeApi();

  const refreshBtn = document.getElementById('launcher-refresh');
  const newSessionBtn = document.getElementById('launcher-new-session');
  const resumeLatestBtn = document.getElementById('launcher-resume-latest');
  const openWorkspaceBtn = document.getElementById('launcher-open-workspace');
  const searchInput = document.getElementById('launcher-search');
  const emptyEl = document.getElementById('launcher-empty');
  const runsEl = document.getElementById('launcher-runs');

  let allRuns = [];
  let namedWorkspacesEnabled = false;

  function formatRelativeTime(iso) {
    if (!iso) return 'Unknown time';
    const when = new Date(iso).getTime();
    if (!Number.isFinite(when)) return 'Unknown time';
    const diffMs = Date.now() - when;
    const future = diffMs < 0;
    const absMs = Math.abs(diffMs);
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    const value = absMs < hour
      ? Math.max(1, Math.round(absMs / minute))
      : absMs < day
        ? Math.max(1, Math.round(absMs / hour))
        : Math.max(1, Math.round(absMs / day));
    const unit = absMs < hour ? 'm' : absMs < day ? 'h' : 'd';
    return future ? `in ${value}${unit}` : `${value}${unit}`;
  }

  function renderRuns() {
    const query = String(searchInput.value || '').trim().toLowerCase();
    const filtered = !query
      ? allRuns
      : allRuns.filter((run) => {
        const haystack = [
          run.title || '',
          run.runId || '',
          run.status || '',
        ].join('\n').toLowerCase();
        return haystack.includes(query);
      });

    resumeLatestBtn.disabled = allRuns.length === 0;
    openWorkspaceBtn.style.display = namedWorkspacesEnabled ? '' : 'none';
    runsEl.innerHTML = '';

    if (filtered.length === 0) {
      emptyEl.textContent = allRuns.length === 0
        ? 'No previous sessions found for this repository.'
        : 'No sessions match the current search.';
      emptyEl.style.display = 'block';
      return;
    }

    emptyEl.style.display = 'none';
    for (const run of filtered) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'launcher-run';
      button.setAttribute('data-run-id', run.runId || '');

      const top = document.createElement('div');
      top.className = 'launcher-run-top';

      const title = document.createElement('div');
      title.className = 'launcher-run-title';
      title.textContent = run.title || run.runId || 'Untitled session';
      top.appendChild(title);

      if (run.isOpen) {
        const openBadge = document.createElement('span');
        openBadge.className = 'launcher-pill launcher-pill-open';
        openBadge.textContent = 'Open';
        top.appendChild(openBadge);
      }

      const meta = document.createElement('div');
      meta.className = 'launcher-run-meta';
      const relative = formatRelativeTime(run.updatedAt);
      meta.textContent = relative + (run.status ? ` • ${run.status}` : '');

      button.appendChild(top);
      button.appendChild(meta);
      button.addEventListener('click', () => {
        vscode.postMessage({ type: 'launcherOpenRun', runId: run.runId });
      });
      runsEl.appendChild(button);
    }
  }

  refreshBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'launcherRefresh' });
  });
  newSessionBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'launcherNewSession' });
  });
  resumeLatestBtn.addEventListener('click', () => {
    if (allRuns.length === 0) return;
    vscode.postMessage({ type: 'launcherResumeLatest' });
  });
  openWorkspaceBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'launcherOpenWorkspace' });
  });
  searchInput.addEventListener('input', renderRuns);

  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.type !== 'launcherData') return;
    allRuns = Array.isArray(msg.runs) ? msg.runs.slice() : [];
    namedWorkspacesEnabled = !!msg.namedWorkspacesEnabled;
    renderRuns();
  });

  vscode.postMessage({ type: 'launcherReady' });
})();
