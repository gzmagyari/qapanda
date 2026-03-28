/**
 * Expand @@tag references in prompt text.
 * @@word is replaced with the contents of word.md from the first matching prompts directory.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function expandPromptTags(text, promptsDirs) {
  if (!text || !text.includes('@@')) return text;
  return text.replace(/@@(\w+)/g, (match, name) => {
    for (const dir of promptsDirs) {
      const file = path.join(dir, name + '.md');
      try { return fs.readFileSync(file, 'utf8'); } catch {}
    }
    return match;
  });
}

function buildPromptsDirs(repoRoot, extensionOrPackageRoot) {
  return [
    repoRoot ? path.join(repoRoot, '.qpanda', 'prompts') : null,
    path.join(os.homedir(), '.qpanda', 'prompts'),
    extensionOrPackageRoot ? path.join(extensionOrPackageRoot, 'prompts') : null,
    path.resolve(__dirname, '..', 'prompts'),
  ].filter(Boolean);
}

module.exports = { expandPromptTags, buildPromptsDirs };
