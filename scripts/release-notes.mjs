import { readReleaseNotes, releaseVersion } from './release-notes-source.mjs';

const heading = `## ${releaseVersion()}`;
const { lines, sections } = readReleaseNotes();
const section = sections.find((item) => item.heading === heading);
if (!section) throw new Error(`Could not find a ${heading} section in RELEASE_NOTES.md`);

process.stdout.write(`${lines.slice(section.start, section.end).join('\n').trim()}\n`);
