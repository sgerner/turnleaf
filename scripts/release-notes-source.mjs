import { readFileSync } from 'node:fs';

export function releaseVersion() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
}

export function readReleaseNotes() {
  const url = new URL('../RELEASE_NOTES.md', import.meta.url);
  const lines = readFileSync(url, 'utf8').split(/\r?\n/);
  const sections = [];
  for (const [index, line] of lines.entries()) {
    if (!line.startsWith('## ')) continue;
    const previous = sections.at(-1);
    if (previous) previous.end = index;
    sections.push({ heading: line.trim(), start: index, end: lines.length });
  }
  return { url, lines, sections };
}
