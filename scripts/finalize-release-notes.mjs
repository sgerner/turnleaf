import { writeFileSync } from 'node:fs';
import { readReleaseNotes, releaseVersion } from './release-notes-source.mjs';

const version = releaseVersion();
const { url, lines, sections: boundaries } = readReleaseNotes();
const prefix = lines.slice(0, boundaries[0]?.start);
const sections = boundaries.map(({ heading, start, end }) => ({
  heading,
  body: lines
    .slice(start + 1, end)
    .join('\n')
    .replace(/^\n+|\n+$/g, ''),
}));

const unreleased = sections.find((section) => section.heading === '## Unreleased');
if (!unreleased) {
  throw new Error('Could not find an Unreleased section in RELEASE_NOTES.md');
}

const versionHeading = `## ${version}`;
let versionSection = sections.find((section) => section.heading === versionHeading);

if (!unreleased.body.trim()) {
  if (versionSection?.body.trim()) process.exit(0);
  throw new Error(`Could not find release notes for ${version} or Unreleased in RELEASE_NOTES.md`);
}

if (!versionSection) {
  versionSection = { heading: versionHeading, body: '' };
  const unreleasedIndex = sections.indexOf(unreleased);
  sections.splice(unreleasedIndex + 1, 0, versionSection);
}

versionSection.body = [versionSection.body, unreleased.body].filter(Boolean).join('\n\n');
unreleased.body = '';

const output = [];
output.push(...prefix);
for (const section of sections) {
  if (output.length > 0 && output[output.length - 1].trim() !== '') {
    output.push('');
  }
  output.push(section.heading, '');
  if (section.body.length > 0) {
    output.push(section.body, '');
  }
}

writeFileSync(url, `${output.join('\n').trimEnd()}\n`);
