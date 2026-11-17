import { describe, expect, it } from 'vitest';
import { selectDeviceSerial } from './android-device.mjs';

const devices = `List of devices attached
emulator-5554 device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64
emulator-5556 device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64
R5CT123456A device product:device model:phone
`;

describe('Android device selection', () => {
  it('selects the only ready emulator for the reading journey', () => {
    expect(
      selectDeviceSerial('List of devices attached\nemulator-5554 device\nR5CT123456A device\n', {
        emulatorOnly: true,
      }),
    ).toBe('emulator-5554');
  });

  it('requires a serial when multiple smoke-test devices are attached', () => {
    expect(() => selectDeviceSerial(devices, { requestedSerial: '' })).toThrow(
      'Multiple Android devices are attached',
    );
  });

  it('uses the requested serial when multiple devices are attached', () => {
    expect(selectDeviceSerial(devices, { requestedSerial: 'emulator-5556' })).toBe('emulator-5556');
  });

  it('rejects a physical device for the reading journey', () => {
    expect(() =>
      selectDeviceSerial(devices, { requestedSerial: 'R5CT123456A', emulatorOnly: true }),
    ).toThrow('Use an Android emulator');
  });
});
