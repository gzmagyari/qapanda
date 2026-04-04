I created an applyable git patch here:

[Download the patch](sandbox:/mnt/data/qapanda-critical-fixes.patch)

From the repo root, apply it with:

```bash
git apply qapanda-critical-fixes.patch
```

What this patch fixes:

* standalone web session reattach and refresh/disconnect stability
* standalone web `apiCatalog` init and PDF export handling
* Orchestrate + wait-mode single-pass bug
* Continue-mode manifest corruption bug
* loop auto-continue timer surviving dispose
* shared task/test domain logic to remove UI/MCP drift
* atomic JSON writes for tasks/tests
* real MCP errors instead of silent success payloads
* bidirectional test↔task linking and backlink cleanup on delete
* persisted bug severity through tasks, QA report payloads, and PDF export
* stale step-status bleed across reruns
* instance restart targeting the wrong desktop
* toolbar “Restart this session” calling start instead of restart
* task MCP in extension/API mode getting `TESTS_FILE` so deletes clean links properly

I also validated that the patch applies cleanly on a pristine copy, passes `node --check` on the touched JS files, and smoke-tested the new task/test flows after applying it.
