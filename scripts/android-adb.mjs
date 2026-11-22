import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const KEYCODE_BACK = 'KEYCODE_BACK';
export const KEYCODE_VOLUME_DOWN = 'KEYCODE_VOLUME_DOWN';
export const KEYCODE_VOLUME_UP = 'KEYCODE_VOLUME_UP';
export const DEFAULT_FONT_SCALE = '1.0';

export function createAdbRunner({ getSerial, execFileImpl = execFile, timeout = 20_000 } = {}) {
  const runExecFile = promisify(execFileImpl);
  return async (...args) => {
    const serial = getSerial?.();
    const { stdout } = await runExecFile('adb', [...(serial ? ['-s', serial] : []), ...args], {
      timeout,
    });
    return stdout.trim();
  };
}

export async function sendKeyEvent(adb, keyCode) {
  await adb('shell', 'input', 'keyevent', String(keyCode));
}

export async function setFontScale(adb, scale) {
  await adb('shell', 'settings', 'put', 'system', 'font_scale', String(scale));
}

export async function getFontScale(adb) {
  const raw = await adb('shell', 'settings', 'get', 'system', 'font_scale');
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function leadingSpaces(line) {
  return line.length - line.trimStart().length;
}

function parseWindowBlocks(lines) {
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed.startsWith('Window #') || !trimmed.endsWith('}:')) continue;
    const openBrace = trimmed.indexOf('Window{');
    if (openBrace < 0) continue;
    const descriptor = trimmed.slice(openBrace + 'Window{'.length, -2).trim();
    const parts = descriptor.split(/\s+/);
    if (parts.length < 3) continue;
    const [token, , ...rest] = parts;
    const component = rest.join(' ');
    const indent = leadingSpaces(line);
    const bodyLines = [];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const candidate = lines[cursor];
      if (candidate.trim().length > 0 && leadingSpaces(candidate) <= indent) break;
      bodyLines.push(candidate);
      cursor += 1;
    }
    blocks.push({
      token,
      component,
      body: bodyLines.join('\n'),
      lines: bodyLines,
    });
    index = cursor - 1;
  }
  return blocks;
}

function parseInsetsControllerLines(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed !== 'InsetsStateController' && trimmed !== 'InsetsStateController:') continue;
    const indent = leadingSpaces(line);
    const section = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor];
      if (candidate.trim().length > 0 && leadingSpaces(candidate) <= indent) break;
      section.push(candidate);
    }
    return section;
  }
  return [];
}

function hasNonEmptyFrame(line) {
  const match = line.match(/\bframe=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  if (!match) return true;
  const [, left, top, right, bottom] = match;
  return Number(right) > Number(left) && Number(bottom) > Number(top);
}

function parseRequestedSystemBars(windowLines) {
  for (const line of windowLines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('mRequestedVisibleTypes=')) continue;
    const rawValue = trimmed.slice('mRequestedVisibleTypes='.length).trim();
    if (rawValue === '' || /[a-zA-Z]/.test(rawValue)) {
      return /\bstatusBars\b/.test(rawValue) && /\bnavigationBars\b/.test(rawValue);
    }
  }
  return null;
}

export function parseWindowDump(
  output,
  packageName,
  activityClass = 'app.turnleaf.reader.MainActivity',
) {
  const targetComponent = `${packageName}/${activityClass}`;
  const lines = output.split(/\r?\n/);
  const blocks = parseWindowBlocks(lines);
  const matchingWindows = blocks.filter((block) => block.component === targetComponent);
  const activityWindow =
    matchingWindows.find((block) => !/\bmAnimatingExit=true\b/.test(block.body)) ??
    matchingWindows[0] ??
    null;

  if (!activityWindow) {
    return {
      windowFound: false,
      windowToken: null,
      keepScreenOn: false,
      systemBarsVisible: null,
    };
  }

  const holdsScreen = lines.some((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith('mHoldScreenWindow=Window{') && trimmed.includes(targetComponent);
  });
  const keepScreenOn = /\bKEEP_SCREEN_ON\b/.test(activityWindow.body) || holdsScreen;

  const requestedBars = parseRequestedSystemBars(activityWindow.lines);
  const insetsLines = parseInsetsControllerLines(lines);
  const statusBarVisibilities = [];
  const navBarVisibilities = [];

  for (const line of insetsLines) {
    if (!line.includes('InsetsSource')) continue;
    const visibleMatch = line.match(/\bvisible=(true|false)\b/);
    if (!visibleMatch) continue;
    const isVisible = visibleMatch[1] === 'true';
    if (/\btype=(?:statusBars|ITYPE_STATUS_BAR)\b/.test(line)) {
      statusBarVisibilities.push(isVisible);
    } else if (
      /\btype=(?:navigationBars|ITYPE_NAVIGATION_BAR)\b/.test(line) &&
      hasNonEmptyFrame(line)
    ) {
      navBarVisibilities.push(isVisible);
    }
  }

  let systemBarsVisible = null;
  if (statusBarVisibilities.length > 0) {
    const statusBarsShown = statusBarVisibilities.some(Boolean);
    const navBarsShown = navBarVisibilities.length === 0 || navBarVisibilities.some(Boolean);
    const insetsShown = statusBarsShown && navBarsShown;
    systemBarsVisible = requestedBars !== null ? insetsShown && requestedBars : insetsShown;
  } else if (requestedBars !== null) {
    systemBarsVisible = requestedBars;
  } else {
    const statusBarWindow = blocks.find((block) => block.component === 'StatusBar');
    const visibleMatch = statusBarWindow?.body.match(/\bisVisible=(true|false)\b/);
    if (visibleMatch) {
      systemBarsVisible = visibleMatch[1] === 'true';
    }
  }

  return {
    windowFound: true,
    windowToken: activityWindow.token,
    keepScreenOn,
    systemBarsVisible,
  };
}

export async function dumpWindowState(adb, packageName, activityClass) {
  const output = await adb('shell', 'dumpsys', 'window');
  return parseWindowDump(output, packageName, activityClass);
}
