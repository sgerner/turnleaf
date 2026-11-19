import { readReleaseNotes, releaseVersion } from './release-notes-source.mjs';

const heading = `## ${releaseVersion()}`;
const { lines, sections } = readReleaseNotes();
const section = sections.find((item) => item.heading === heading);
if (!section || !lines.slice(section.start + 1, section.end).some((line) => line.trim())) {
  throw new Error(`Could not find release notes under ${heading} in RELEASE_NOTES.md`);
}

process.stdout.write(`${lines.slice(section.start, section.end).join('\n').trim()}\n`);
