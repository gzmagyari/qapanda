# QA Panda Cloud-Run Spec

QA Panda cloud execution now uses an explicit file-based contract:

```bash
qapanda cloud-run --spec ./run-spec.json --raw-events
```

Current version:

```json
{
  "version": "qapanda.cloud-run/v1"
}
```

## v1 shape

```json
{
  "version": "qapanda.cloud-run/v1",
  "runId": "run_123",
  "attemptId": "attempt_123",
  "repositoryId": "repo_123",
  "outputDir": "./output",
  "repositoryContextId": "ctx_123",
  "title": "Smoke test login flow",
  "prompt": "Open the target and verify the login form renders.",
  "targetUrl": "https://example.test/login",
  "targetType": "web",
  "browserPreset": "desktop_chrome",
  "aiProfile": {
    "profileId": "profile_123",
    "name": "Default Browser QA",
    "provider": "openai",
    "model": "gpt-5"
  }
}
```

Required fields:
- `version`
- `runId`
- `attemptId`
- `repositoryId`
- `outputDir`
- `title`
- `prompt`

Nullable fields:
- `repositoryContextId`
- `targetUrl`
- `targetType`
- `browserPreset`
- `aiProfile`

Optional hosted workflow fields:
- `workflowDefinition`
- `workflowProfile`
- `workflowInputs`
- `workflowSecretRefs`

### Hosted workflow extension

Cloud-run specs may also carry structured workflow metadata for hosted workflow execution. The base `title` and `prompt` fields remain required for backward compatibility, but hosted workflow runs add the workflow-specific blocks below:

```json
{
  "workflowDefinition": {
    "id": "deep-login",
    "name": "Deep Login",
    "description": "Hosted login workflow",
    "preferredMode": "orchestrate",
    "suggestedAgent": "QA-Browser",
    "body": "# Goal\n\nTest the login page deeply.\n",
    "inputs": [
      { "id": "environment_url", "label": "Environment URL", "type": "text", "required": true },
      { "id": "login_password", "label": "Password", "type": "text", "secret": true, "required": true }
    ]
  },
  "workflowProfile": {
    "profileId": "staging-login",
    "name": "Staging Login"
  },
  "workflowInputs": {
    "environment_url": "https://staging.example.test/login"
  },
  "workflowSecretRefs": {
    "login_password": "secret-login-password"
  }
}
```

Notes:
- Hosted workflow execution currently supports project workflows only.
- Hosted workflow execution currently supports orchestrate-style workflows only.
- `workflowInputs` is for non-secret launch values only.
- Secret-marked workflow fields must be passed by reference through `workflowSecretRefs`, never inline in `workflowInputs`.
- `workflowSecretRefs` stores opaque secret ids only. Raw secret values must not be written into spec files, manifests, sync payloads, or output bundles.

## Behavior

- `qapanda cloud-run` loads and validates the JSON file explicitly.
- `outputDir` is where QA Panda writes the deterministic cloud-run bundle (`run-report.json`, `session.log`, `evidence-bundle.json`, copied run files, and screenshots when present).
- Invalid specs fail with a clear `Invalid cloud-run spec: ...` error.
- `--raw-events` emits newline-delimited hosted raw events (`session.started`, `session.note`, `browser.navigation`, `artifact.created`, `session.completed` / `session.failed`) expected by the hosted worker.

## Compatibility note

The platform worker should invoke QA Panda with `cloud-run --spec <file> --raw-events`. The hidden `QAPANDA_RUN_SPEC` environment contract is no longer the supported integration path.
