import { writeFileSync } from 'node:fs';
import { readReleaseNotes } from './release-notes-source.mjs';

const [mode, value] = process.argv.slice(2);
const subject = mode === '--subject' ? value?.trim() : '';

if (!subject || /^merge\b/i.test(subject)) process.exit(0);

const { url, lines, sections } = readReleaseNotes();
const unreleased = sections.find((section) => section.heading === '## Unreleased');

if (!unreleased) {
  lines.unshift('# Release Notes', '', '## Unreleased', '', `- ${subject}`);
  writeFileSync(url, `${lines.join('\n').trimEnd()}\n`);
  process.exit(0);
}

const sectionLines = lines.slice(unreleased.start + 1, unreleased.end);

if (sectionLines.some((line) => line.trim() === `- ${subject}`)) process.exit(0);

let insertionIndex = unreleased.start + 1;
if (lines[insertionIndex]?.trim() !== '') {
  lines.splice(insertionIndex, 0, '');
}
lines.splice(insertionIndex + 1, 0, `- ${subject}`);
if (lines[insertionIndex + 2]?.startsWith('## ')) lines.splice(insertionIndex + 2, 0, '');

writeFileSync(url, `${lines.join('\n').trimEnd()}\n`);
