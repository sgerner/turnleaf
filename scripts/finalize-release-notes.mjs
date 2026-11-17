import { writeFileSync } from 'node:fs';
import { readReleaseNotes, releaseVersion } from './release-notes-source.mjs';

const version = releaseVersion();
const { url, lines, sections: boundaries } = readReleaseNotes();
const prefix = lines.slice(0, boundaries[0]?.start);
const sections = boundaries.map(({ heading, start, end }) => ({
  heading,
  body: lines
    .slice(start + 1, end)
    .filter((line) => line.trim())
    .map((line) => line.trimEnd()),
}));

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

writeFileSync(url, `${output.join('\n').trimEnd()}\n`);
