import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../RELEASE_NOTES.md', import.meta.url), 'utf8');
const lines = source.split(/\r?\n/);
const start = lines.findIndex((line) => line.trim() === '## Unreleased');

if (start < 0) {
  throw new Error('Could not find an Unreleased section in RELEASE_NOTES.md');
}

const output = [];
for (let index = start; index < lines.length; index += 1) {
  const line = lines[index];
  if (index > start && line.startsWith('## ')) break;
  output.push(line);
}

process.stdout.write(`${output.join('\n').trim()}\n`);
