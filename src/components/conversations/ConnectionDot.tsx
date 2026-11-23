import type { PeerRecord } from '../../core/types.js';

export function ConnectionDot({
  peer,
  connected,
  connecting,
  failed,
}: {
  peer: PeerRecord;
  connected: boolean;
  connecting: boolean;
  failed: boolean;
}) {
  const label = connected
    ? 'Connected'
    : connecting
      ? 'Connecting'
      : failed
        ? 'Connection failed'
        : 'Disconnected';
  const status = connected
    ? 'connected'
    : connecting
      ? 'connecting'
      : failed
        ? 'failed'
        : 'disconnected';
  const color = {
    connected: 'status-success',
    connecting: 'status-warning',
    failed: 'status-error',
    disconnected: 'status-error',
  }[status];
  return (
    <span
      class="tooltip tooltip-left conversation-status"
      data-tip={label}
      role="img"
      aria-label={`${peer.name}: ${label}`}
      title={`${peer.name}: ${label}`}
    >
      <span class={`status status-sm ${color}`} aria-hidden="true" />
    </span>
  );
}
