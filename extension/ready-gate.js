function normalizeReadySessionId(msg) {
  if (!msg || msg.readySessionId === undefined || msg.readySessionId === null || msg.readySessionId === '') {
    return 'legacy';
  }
  return String(msg.readySessionId);
}

function createReadyGate(processReady) {
  let activeSessionId = null;
  let inFlight = null;
  let replayReady = null;

  return async function handleReady(msg) {
    const readySessionId = normalizeReadySessionId(msg);

    if (activeSessionId === readySessionId) {
      if (inFlight) {
        return inFlight;
      }
      if (typeof replayReady === 'function') {
        return replayReady(msg);
      }
    }

    activeSessionId = readySessionId;
    const currentPromise = (async () => {
      replayReady = await processReady(msg, readySessionId);
      return replayReady;
    })();
    inFlight = currentPromise;
    try {
      return await currentPromise;
    } finally {
      if (inFlight === currentPromise) {
        inFlight = null;
      }
    }
  };
}

module.exports = { createReadyGate, normalizeReadySessionId };
