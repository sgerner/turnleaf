// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { EpubTransferError } from '../downloads/native-download';
import { KavitaError } from './client';
import {
  applyKavitaFailure,
  applyKavitaSuccess,
  applyNetworkStatusChange,
  canAttemptKavitaRequest,
  createReachabilityState,
  hasActiveTransport,
  isKavitaNetworkFailure,
} from './reachability';

describe('active transport detection and reachability transitions', () => {
  it('treats unvalidated native Wi-Fi, cellular, and unknown (Ethernet/VPN) transports as online', () => {
    const wifiLan = createReachabilityState(
      { connected: false, connectionType: 'wifi' },
      { native: true },
    );
    expect(wifiLan).toEqual({
      offline: false,
      connectionType: 'wifi',
      validated: false,
      kavitaUnreachable: false,
    });
    expect(canAttemptKavitaRequest(wifiLan, { manual: false })).toBe(true);
    expect(canAttemptKavitaRequest(wifiLan, { manual: true })).toBe(true);

    const vpnOrEthernet = createReachabilityState(
      { connected: false, connectionType: 'unknown' },
      { native: true },
    );
    expect(vpnOrEthernet).toEqual({
      offline: false,
      connectionType: 'unknown',
      validated: false,
      kavitaUnreachable: false,
    });
    expect(canAttemptKavitaRequest(vpnOrEthernet, { manual: false })).toBe(true);

    const cellularUnvalidated = createReachabilityState(
      { connected: false, connectionType: 'cellular' },
      { native: true },
    );
    expect(cellularUnvalidated.offline).toBe(false);
    expect(cellularUnvalidated.connectionType).toBe('cellular');
  });

  it('marks the device offline when native reports connectionType none or status is unavailable', () => {
    const disconnected = createReachabilityState(
      { connected: false, connectionType: 'none' },
      { native: true },
    );
    expect(disconnected).toEqual({
      offline: true,
      connectionType: 'none',
      validated: false,
      kavitaUnreachable: false,
    });
    expect(canAttemptKavitaRequest(disconnected, { manual: false })).toBe(false);
    expect(canAttemptKavitaRequest(disconnected, { manual: true })).toBe(false);

    expect(hasActiveTransport(null, { native: true })).toBe(false);
    expect(
      hasActiveTransport(
        { connected: true, connectionType: 'wifi' },
        { native: true, browserOnline: false },
      ),
    ).toBe(false);
  });

  it('marks the browser offline only when navigator.onLine is false or connectionType is none', () => {
    expect(
      hasActiveTransport(
        { connected: true, connectionType: 'unknown' },
        { native: false, browserOnline: true },
      ),
    ).toBe(true);
    expect(
      hasActiveTransport(null, {
        native: false,
        browserOnline: true,
      }),
    ).toBe(true);
    expect(
      hasActiveTransport(
        { connected: true, connectionType: 'wifi' },
        { native: false, browserOnline: false },
      ),
    ).toBe(false);
    expect(
      hasActiveTransport(
        { connected: false, connectionType: 'none' },
        { native: false, browserOnline: true },
      ),
    ).toBe(false);
  });

  it('marks Kavita unreachable only on network errors and keeps manual requests enabled', () => {
    const active = createReachabilityState(
      { connected: false, connectionType: 'wifi' },
      { native: true },
    );

    const authFailed = applyKavitaFailure(
      active,
      new KavitaError('Kavita rejected this auth key.', 'authentication', 401),
    );
    expect(authFailed.kavitaUnreachable).toBe(false);

    const serverFailed = applyKavitaFailure(
      active,
      new KavitaError('Kavita returned an error (500).', 'server', 500),
    );
    expect(serverFailed.kavitaUnreachable).toBe(false);

    const invalidPayload = applyKavitaFailure(
      active,
      new KavitaError('Kavita response could not be read.', 'invalid-response'),
    );
    expect(invalidPayload.kavitaUnreachable).toBe(false);

    const httpTransferError = applyKavitaFailure(active, new EpubTransferError(503, false));
    expect(httpTransferError.kavitaUnreachable).toBe(false);

    const networkFailed = applyKavitaFailure(
      active,
      new KavitaError('Kavita could not be reached.', 'network'),
    );
    expect(networkFailed.kavitaUnreachable).toBe(true);
    expect(canAttemptKavitaRequest(networkFailed, { manual: false })).toBe(false);
    expect(canAttemptKavitaRequest(networkFailed, { manual: true })).toBe(true);

    const recovered = applyKavitaSuccess(networkFailed);
    expect(recovered.kavitaUnreachable).toBe(false);
    expect(canAttemptKavitaRequest(recovered, { manual: false })).toBe(true);
  });

  it('detects network failures wrapped in EpubTransferError, FileTransfer codes, and AggregateError', () => {
    expect(isKavitaNetworkFailure(new EpubTransferError(undefined, true))).toBe(true);
    expect(isKavitaNetworkFailure(new EpubTransferError(undefined, true, true))).toBe(false);
    expect(
      isKavitaNetworkFailure(new KavitaError('No network connection.', 'network', undefined, true)),
    ).toBe(false);
    expect(isKavitaNetworkFailure({ code: 'OS-PLUG-FLTR-0008' })).toBe(true);
    expect(
      isKavitaNetworkFailure(
        new AggregateError(
          [
            new KavitaError('Auth error', 'authentication', 401),
            new KavitaError('Network down', 'network'),
          ],
          'Sync failed',
        ),
      ),
    ).toBe(true);
    expect(
      isKavitaNetworkFailure(
        new AggregateError(
          [new KavitaError('No network connection.', 'network', undefined, true)],
          'Sync skipped',
        ),
      ),
    ).toBe(false);
    expect(
      isKavitaNetworkFailure(
        new AggregateError([new KavitaError('Auth error', 'authentication', 401)], 'Sync failed'),
      ),
    ).toBe(false);
  });

  it('preserves unreachable state on duplicate status events, clears it on transport change or reconnect, and disconnects cleanly', () => {
    const cellular = createReachabilityState(
      { connected: true, connectionType: 'cellular' },
      { native: true },
    );
    const healthyWifiHandoff = applyNetworkStatusChange(
      cellular,
      { connected: true, connectionType: 'wifi' },
      { native: true },
    );
    expect(healthyWifiHandoff).toEqual({
      state: {
        offline: false,
        connectionType: 'wifi',
        validated: true,
        kavitaUnreachable: false,
      },
      disconnected: false,
      shouldReconnect: false,
    });

    const unreachableOnCellular = applyKavitaFailure(
      cellular,
      new KavitaError('Kavita could not be reached.', 'network'),
    );
    expect(unreachableOnCellular.kavitaUnreachable).toBe(true);

    const duplicateCellular = applyNetworkStatusChange(
      unreachableOnCellular,
      { connected: true, connectionType: 'cellular' },
      { native: true },
    );
    expect(duplicateCellular.disconnected).toBe(false);
    expect(duplicateCellular.shouldReconnect).toBe(false);
    expect(duplicateCellular.state.kavitaUnreachable).toBe(true);

    const switchedToLanWifi = applyNetworkStatusChange(
      duplicateCellular.state,
      { connected: false, connectionType: 'wifi' },
      { native: true },
    );
    expect(switchedToLanWifi.disconnected).toBe(false);
    expect(switchedToLanWifi.shouldReconnect).toBe(true);
    expect(switchedToLanWifi.state).toEqual({
      offline: false,
      connectionType: 'wifi',
      validated: false,
      kavitaUnreachable: false,
    });

    const unreachableOnPortalWifi = applyKavitaFailure(
      switchedToLanWifi.state,
      new KavitaError('Kavita could not be reached.', 'network'),
    );
    const portalValidated = applyNetworkStatusChange(
      unreachableOnPortalWifi,
      { connected: true, connectionType: 'wifi' },
      { native: true },
    );
    expect(portalValidated.shouldReconnect).toBe(true);
    expect(portalValidated.state.kavitaUnreachable).toBe(false);

    const lostAllTransports = applyNetworkStatusChange(
      portalValidated.state,
      { connected: false, connectionType: 'none' },
      { native: true },
    );
    expect(lostAllTransports).toEqual({
      state: {
        offline: true,
        connectionType: 'none',
        validated: false,
        kavitaUnreachable: false,
      },
      disconnected: true,
      shouldReconnect: false,
    });

    const reconnectedToLanWifi = applyNetworkStatusChange(
      lostAllTransports.state,
      { connected: false, connectionType: 'wifi' },
      { native: true },
    );
    expect(reconnectedToLanWifi).toEqual({
      state: {
        offline: false,
        connectionType: 'wifi',
        validated: false,
        kavitaUnreachable: false,
      },
      disconnected: false,
      shouldReconnect: true,
    });
  });
});
