import { readFileSync, writeFileSync } from 'node:fs';

const [mode, value] = process.argv.slice(2);

let subject = '';
if (mode === '--subject') {
  subject = value ?? '';
} else if (mode) {
  const rawMessage = readFileSync(mode, 'utf8').trim();
  subject = rawMessage.split(/\r?\n/, 1)[0].trim();
}

if (!subject || /^merge\b/i.test(subject)) process.exit(0);

const notesUrl = new URL('../RELEASE_NOTES.md', import.meta.url);
const source = readFileSync(notesUrl, 'utf8');
const lines = source.split(/\r?\n/);
let headingIndex = lines.findIndex((line) => line.trim() === '## Unreleased');

if (headingIndex < 0) {
  lines.unshift('# Release Notes', '', '## Unreleased', '', `- ${subject}`);
  writeFileSync(notesUrl, `${lines.join('\n').trimEnd()}\n`);
  process.exit(0);
}

const nextHeadingIndex = lines.findIndex((line, index) => index > headingIndex && line.startsWith('## '));
const sectionEnd = nextHeadingIndex === -1 ? lines.length : nextHeadingIndex;
const sectionLines = lines.slice(headingIndex + 1, sectionEnd);

if (sectionLines.some((line) => line.trim() === `- ${subject}`)) process.exit(0);

let insertionIndex = headingIndex + 1;
if (lines[insertionIndex]?.trim() !== '') {
  lines.splice(insertionIndex, 0, '');
}
lines.splice(insertionIndex + 1, 0, `- ${subject}`);

writeFileSync(notesUrl, `${lines.join('\n').trimEnd()}\n`);
