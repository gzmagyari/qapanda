const path = require('node:path');
const { writeJson } = require('./utils');

const controllerDecisionSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['delegate', 'stop'],
    },
    controller_messages: {
      type: 'array',
      items: { type: 'string' },
    },
    claude_message: {
      type: ['string', 'null'],
    },
    stop_reason: {
      type: ['string', 'null'],
    },
    progress_updates: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['action', 'controller_messages', 'claude_message', 'stop_reason', 'progress_updates'],
  additionalProperties: false,
};

function validateControllerDecision(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Controller decision must be an object.');
  }

  const action = value.action;
  if (action !== 'delegate' && action !== 'stop') {
    throw new Error(`Controller action must be "delegate" or "stop", received: ${action}`);
  }

  if (!Array.isArray(value.controller_messages)) {
    throw new Error('controller_messages must be an array of strings.');
  }

  const controllerMessages = value.controller_messages.map((entry) => {
    if (typeof entry !== 'string') {
      throw new Error('controller_messages must contain only strings.');
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      throw new Error('controller_messages cannot contain empty strings.');
    }
    return trimmed;
  });

  if (action === 'delegate') {
    if (typeof value.claude_message !== 'string' || !value.claude_message.trim()) {
      throw new Error('claude_message must be a non-empty string when action is delegate.');
    }
  } else if (value.claude_message !== null) {
    throw new Error('claude_message must be null when action is stop.');
  }

  if (value.stop_reason != null && typeof value.stop_reason !== 'string') {
    throw new Error('stop_reason must be a string or null.');
  }

  const progressUpdates = [];
  if (value.progress_updates != null) {
    if (!Array.isArray(value.progress_updates)) {
      throw new Error('progress_updates must be an array of strings.');
    }
    for (const entry of value.progress_updates) {
      if (typeof entry !== 'string') {
        throw new Error('progress_updates must contain only strings.');
      }
      const trimmed = entry.trim();
      if (trimmed) progressUpdates.push(trimmed);
    }
  }

  return {
    action,
    controller_messages: controllerMessages,
    claude_message: action === 'delegate' ? value.claude_message.trim() : null,
    stop_reason: value.stop_reason == null ? null : String(value.stop_reason).trim(),
    progress_updates: progressUpdates,
  };
}

async function writeControllerSchema(schemaFile) {
  await writeJson(schemaFile, controllerDecisionSchema);
  return schemaFile;
}

function defaultSchemaPath(runDir) {
  return path.join(runDir, 'controller-decision.schema.json');
}

module.exports = {
  controllerDecisionSchema,
  defaultSchemaPath,
  validateControllerDecision,
  writeControllerSchema,
};
