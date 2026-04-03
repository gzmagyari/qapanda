const fs = require('node:fs');
const path = require('node:path');

const TOOLS = [
  {
    name: 'get_memory',
    description: 'Read the project memory file in full or by exact line range',
    inputSchema: {
      type: 'object',
      properties: {
        from_line: { type: 'number', description: '1-based start line (optional)' },
        to_line: { type: 'number', description: '1-based end line inclusive (optional)' },
      },
    },
  },
  {
    name: 'search_memory',
    description: 'Search project memory by keyword(s) or regex and return bounded context around matches',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Plain-text keyword search, supports multiple space-separated keywords' },
        regex: { type: 'string', description: 'Regex pattern to search for' },
        case_sensitive: { type: 'boolean', description: 'Case-sensitive search (default false)' },
        context_before: { type: 'number', description: 'Lines of context before each match (default 2)' },
        context_after: { type: 'number', description: 'Lines of context after each match (default 2)' },
        max_matches: { type: 'number', description: 'Maximum number of matches to return (default 10)' },
        max_total_lines: { type: 'number', description: 'Maximum total context lines returned across all matches (default 80)' },
      },
    },
  },
  {
    name: 'write_memory',
    description: 'Overwrite the entire project memory file',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Full new contents of MEMORY.md' },
      },
      required: ['content'],
    },
  },
  {
    name: 'replace_memory_text',
    description: 'Replace exact text in the project memory file, in single-match mode by default',
    inputSchema: {
      type: 'object',
      properties: {
        find: { type: 'string', description: 'Exact text to find' },
        replace: { type: 'string', description: 'Replacement text' },
        replace_all: { type: 'boolean', description: 'Replace all matches instead of requiring a single unique match' },
      },
      required: ['find', 'replace'],
    },
  },
  {
    name: 'replace_memory_lines',
    description: 'Replace an exact numeric line range in project memory',
    inputSchema: {
      type: 'object',
      properties: {
        from_line: { type: 'number', description: '1-based start line inclusive' },
        to_line: { type: 'number', description: '1-based end line inclusive' },
        content: { type: 'string', description: 'Replacement text for that line range' },
      },
      required: ['from_line', 'to_line', 'content'],
    },
  },
];

function loadMemoryFile(memoryFile) {
  try {
    return fs.readFileSync(memoryFile, 'utf8');
  } catch {
    return '';
  }
}

function saveMemoryFile(memoryFile, content) {
  fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
  fs.writeFileSync(memoryFile, String(content || ''), 'utf8');
}

function toLines(text) {
  const normalized = String(text || '').replace(/\r\n/g, '\n');
  if (!normalized) return [];
  const lines = normalized.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function clampPositiveInt(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 1) return fallback;
  return Math.floor(num);
}

function clampNonNegativeInt(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return fallback;
  return Math.floor(num);
}

function resolveSlice(lines, fromLine, toLine) {
  const total = lines.length;
  const from = clampPositiveInt(fromLine, 1);
  const to = clampPositiveInt(toLine, total || 1);
  if (from > to) throw new Error(`Invalid line range: from_line ${from} is greater than to_line ${to}`);
  return {
    from,
    to,
    lines: total === 0 ? [] : lines.slice(from - 1, to),
    total,
  };
}

function buildQueryMatcher(query, caseSensitive) {
  const tokens = String(query || '')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    throw new Error('search_memory requires a non-empty query or regex');
  }
  if (!caseSensitive) {
    const lowered = tokens.map((token) => token.toLowerCase());
    return (line) => {
      const haystack = String(line || '').toLowerCase();
      return lowered.every((token) => haystack.includes(token));
    };
  }
  return (line) => {
    const haystack = String(line || '');
    return tokens.every((token) => haystack.includes(token));
  };
}

function buildRegexMatcher(pattern, caseSensitive) {
  let regex;
  try {
    regex = new RegExp(pattern, caseSensitive ? 'g' : 'gi');
  } catch (error) {
    throw new Error(`Invalid regex: ${error.message}`);
  }
  return (line) => {
    regex.lastIndex = 0;
    return regex.test(String(line || ''));
  };
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let start = 0;
  while (true) {
    const idx = haystack.indexOf(needle, start);
    if (idx === -1) return count;
    count += 1;
    start = idx + needle.length;
  }
}

function handleToolCall(name, args, memoryFile) {
  const content = loadMemoryFile(memoryFile);
  const lines = toLines(content);

  switch (name) {
    case 'get_memory': {
      if (args.from_line == null && args.to_line == null) {
        return JSON.stringify({
          total_lines: lines.length,
          from_line: lines.length > 0 ? 1 : 0,
          to_line: lines.length,
          content,
        }, null, 2);
      }
      const slice = resolveSlice(lines, args.from_line, args.to_line);
      return JSON.stringify({
        total_lines: slice.total,
        from_line: slice.lines.length > 0 ? slice.from : 0,
        to_line: slice.lines.length > 0 ? slice.to : 0,
        content: slice.lines.join('\n'),
      }, null, 2);
    }

    case 'search_memory': {
      const caseSensitive = !!args.case_sensitive;
      const contextBefore = clampNonNegativeInt(args.context_before, 2);
      const contextAfter = clampNonNegativeInt(args.context_after, 2);
      const maxMatches = clampPositiveInt(args.max_matches, 10);
      const maxTotalLines = clampPositiveInt(args.max_total_lines, 80);
      const matcher = args.regex
        ? buildRegexMatcher(args.regex, caseSensitive)
        : buildQueryMatcher(args.query, caseSensitive);
      const matches = [];
      let totalContextLines = 0;
      let truncated = false;

      for (let index = 0; index < lines.length; index += 1) {
        if (!matcher(lines[index])) continue;
        if (matches.length >= maxMatches) {
          truncated = true;
          break;
        }
        const startLine = Math.max(1, index + 1 - contextBefore);
        const endLine = Math.min(lines.length, index + 1 + contextAfter);
        const context = [];
        for (let lineNo = startLine; lineNo <= endLine; lineNo += 1) {
          context.push({ line: lineNo, text: lines[lineNo - 1] });
        }
        if ((totalContextLines + context.length) > maxTotalLines) {
          truncated = true;
          break;
        }
        totalContextLines += context.length;
        matches.push({
          line: index + 1,
          text: lines[index],
          start_line: startLine,
          end_line: endLine,
          context,
        });
      }

      return JSON.stringify({
        total_lines: lines.length,
        matches,
        truncated,
        max_matches: maxMatches,
        max_total_lines: maxTotalLines,
      }, null, 2);
    }

    case 'write_memory': {
      saveMemoryFile(memoryFile, args.content);
      const updatedLines = toLines(args.content);
      return JSON.stringify({
        ok: true,
        total_lines: updatedLines.length,
      }, null, 2);
    }

    case 'replace_memory_text': {
      const find = String(args.find || '');
      const replace = String(args.replace || '');
      if (!find) throw new Error('replace_memory_text requires a non-empty find string');
      const count = countOccurrences(content, find);
      if (count === 0) {
        throw new Error('replace_memory_text found 0 matches');
      }
      if (args.replace_all !== true && count > 1) {
        throw new Error(`replace_memory_text found ${count} matches; be more specific or set replace_all=true`);
      }
      const next = args.replace_all === true
        ? content.split(find).join(replace)
        : content.replace(find, replace);
      saveMemoryFile(memoryFile, next);
      return JSON.stringify({
        ok: true,
        matches_replaced: args.replace_all === true ? count : 1,
      }, null, 2);
    }

    case 'replace_memory_lines': {
      const from = clampPositiveInt(args.from_line, 0);
      const to = clampPositiveInt(args.to_line, 0);
      if (from < 1 || to < 1) throw new Error('replace_memory_lines requires positive from_line and to_line');
      if (from > to) throw new Error(`Invalid line range: from_line ${from} is greater than to_line ${to}`);
      if (lines.length > 0 && to > lines.length) {
        throw new Error(`replace_memory_lines range ${from}-${to} exceeds total lines ${lines.length}`);
      }
      if (lines.length === 0 && (from !== 1 || to !== 1)) {
        throw new Error('replace_memory_lines can only target 1-1 on an empty memory file');
      }
      const replacementLines = toLines(args.content);
      const nextLines = [
        ...lines.slice(0, from - 1),
        ...replacementLines,
        ...lines.slice(to),
      ];
      saveMemoryFile(memoryFile, nextLines.join('\n'));
      return JSON.stringify({
        ok: true,
        from_line: from,
        to_line: to,
        inserted_lines: replacementLines.length,
        total_lines: nextLines.length,
      }, null, 2);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

module.exports = {
  TOOLS,
  handleToolCall,
};
