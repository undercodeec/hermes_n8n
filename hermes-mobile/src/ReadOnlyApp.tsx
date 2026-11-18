import { StagingShell } from './StagingShell';
import { MobileInboxScreen } from './MobileInboxScreen';

/** Separate entrypoint: this bundle contains only the protected Inbox. */
export default function ReadOnlyApp() {
  return <StagingShell renderReadOnly={(authorizedGet, logout, activity, accessLost) =>
    <MobileInboxScreen authorizedGet={authorizedGet} onLogout={logout} onActivity={activity} onAccessLost={accessLost} />
  } />;
}
