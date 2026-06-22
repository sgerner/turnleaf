import { readFileSync, writeFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const version = packageJson.version;
const notesUrl = new URL('../RELEASE_NOTES.md', import.meta.url);
const source = readFileSync(notesUrl, 'utf8');
const lines = source.split(/\r?\n/);

const sections = [];
const prefix = [];
let current = null;

for (const line of lines) {
  if (line.startsWith('## ')) {
    if (current) sections.push(current);
    current = { heading: line.trim(), body: [] };
    continue;
  }

  if (current) {
    current.body.push(line);
  } else {
    prefix.push(line);
  }
}

if (current) sections.push(current);

const unreleased = sections.find((section) => section.heading === '## Unreleased');
if (!unreleased) {
  throw new Error('Could not find an Unreleased section in RELEASE_NOTES.md');
}

const versionHeading = `## ${version}`;
let versionSection = sections.find((section) => section.heading === versionHeading);

const unreleasedItems = unreleased.body.map((line) => line.trim()).filter(Boolean);
const versionItems = versionSection
  ? versionSection.body.map((line) => line.trim()).filter(Boolean)
  : [];

if (unreleasedItems.length === 0 && versionSection) {
  process.exit(0);
}

if (!versionSection) {
  versionSection = { heading: versionHeading, body: [] };
  const unreleasedIndex = sections.indexOf(unreleased);
  sections.splice(unreleasedIndex + 1, 0, versionSection);
}

const existing = new Set(versionItems);
versionSection.body = [...versionItems];
for (const item of unreleasedItems) {
  if (!existing.has(item)) {
    versionSection.body.push(item);
    existing.add(item);
  }
}

unreleased.body = [];

const output = [];
output.push(...prefix);
for (const section of sections) {
  if (output.length > 0 && output[output.length - 1].trim() !== '') {
    output.push('');
  }
  output.push(section.heading, '');
  if (section.body.length > 0) {
    output.push(...section.body, '');
  }
}

writeFileSync(notesUrl, `${output.join('\n').trimEnd()}\n`);
