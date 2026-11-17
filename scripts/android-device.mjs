import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export function selectDeviceSerial(
  devicesOutput,
  { requestedSerial = process.env.ANDROID_SERIAL, emulatorOnly = false } = {},
) {
  const devices = devicesOutput
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state === 'device');
  const emulators = devices.filter(([serial]) => serial.startsWith('emulator-'));
  const eligibleDevices = emulatorOnly ? emulators : devices;
  const requested = requestedSerial?.trim();

  if (requested) {
    if (!devices.some(([serial]) => serial === requested)) {
      throw new Error(`ANDROID_SERIAL ${requested} is not an attached, ready device.`);
    }
    if (emulatorOnly && !requested.startsWith('emulator-')) {
      throw new Error('Use an Android emulator for the reading journey.');
    }
    return requested;
  }
  if (eligibleDevices.length === 0) {
    throw new Error(
      emulatorOnly
        ? 'Use an attached Android emulator for the reading journey.'
        : 'Connect an Android device or emulator to run the Android smoke check.',
    );
  }
  if (eligibleDevices.length > 1) {
    throw new Error(
      `Multiple Android ${emulatorOnly ? 'emulators' : 'devices'} are attached. Set ANDROID_SERIAL to the target.`,
    );
  }
  return eligibleDevices[0][0];
}

export async function resolveDeviceSerial(options) {
  const { stdout } = await promisify(execFile)('adb', ['devices'], { timeout: 20_000 });
  return selectDeviceSerial(stdout, options);
}
