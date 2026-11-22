import type { ConnectionStatus, ConnectionType } from '@capacitor/network';
import { EpubTransferError } from '../downloads/native-download';
import { KavitaError } from './client';

export interface TransportCheckOptions {
  native?: boolean;
  browserOnline?: boolean;
}

export interface ReachabilityState {
  offline: boolean;
  connectionType: ConnectionType;
  validated: boolean;
  kavitaUnreachable: boolean;
}

export interface ReachabilityTransition {
  state: ReachabilityState;
  disconnected: boolean;
  shouldReconnect: boolean;
}

export function hasActiveTransport(
  status: ConnectionStatus | null | undefined,
  options: TransportCheckOptions = {},
): boolean {
  const native = options.native ?? true;
  if (native) {
    return status != null && status.connectionType !== 'none';
  }
  if (options.browserOnline === false) {
    return false;
  }
  if (status == null) {
    return true;
  }
  return status.connectionType !== 'none';
}

export function createReachabilityState(
  status: ConnectionStatus | null | undefined,
  options: TransportCheckOptions = {},
): ReachabilityState {
  const active = hasActiveTransport(status, options);
  return {
    offline: !active,
    connectionType: active ? (status?.connectionType ?? 'unknown') : 'none',
    validated: active && status?.connected === true,
    kavitaUnreachable: false,
  };
}

export function applyNetworkStatusChange(
  previous: ReachabilityState,
  status: ConnectionStatus | null | undefined,
  options: TransportCheckOptions = {},
): ReachabilityTransition {
  const active = hasActiveTransport(status, options);
  if (!active) {
    return {
      state: {
        offline: true,
        connectionType: 'none',
        validated: false,
        kavitaUnreachable: false,
      },
      disconnected: true,
      shouldReconnect: false,
    };
  }

  const nextType = status?.connectionType ?? 'unknown';
  const nextValidated = status?.connected === true;
  const shouldReconnect =
    previous.offline ||
    previous.connectionType !== nextType ||
    (!previous.validated && nextValidated);

  return {
    state: {
      offline: false,
      connectionType: nextType,
      validated: nextValidated,
      kavitaUnreachable: shouldReconnect ? false : previous.kavitaUnreachable,
    },
    disconnected: false,
    shouldReconnect,
  };
}

export function isKavitaNetworkFailure(error: unknown): boolean {
  if (error instanceof KavitaError) {
    return error.kind === 'network';
  }
  if (error instanceof EpubTransferError) {
    return error.connectionFailed;
  }
  if (error instanceof AggregateError) {
    return error.errors.some((cause) => isKavitaNetworkFailure(cause));
  }
  return (error as { code?: unknown } | null)?.code === 'OS-PLUG-FLTR-0008';
}

export function applyKavitaFailure(state: ReachabilityState, error: unknown): ReachabilityState {
  if (state.offline || !isKavitaNetworkFailure(error)) {
    return state;
  }
  if (state.kavitaUnreachable) {
    return state;
  }
  return {
    ...state,
    kavitaUnreachable: true,
  };
}

export function applyKavitaSuccess(state: ReachabilityState): ReachabilityState {
  if (!state.kavitaUnreachable) {
    return state;
  }
  return {
    ...state,
    kavitaUnreachable: false,
  };
}

export function canAttemptKavitaRequest(
  state: ReachabilityState,
  options: { manual?: boolean } = {},
): boolean {
  if (state.offline) {
    return false;
  }
  if (!options.manual && state.kavitaUnreachable) {
    return false;
  }
  return true;
}
