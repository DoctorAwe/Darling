import type { RemoteSessionState, User } from '../../../packages/protocol/src/index';

export function remoteWindowPolicy(remote: RemoteSessionState | null | undefined, user: User | undefined, controllerWindowExists: boolean) {
  const live = !!remote && (remote.phase === 'connecting' || remote.phase === 'active');
  const isController = !!remote && remote.controller === user;
  return {
    createController: live && isController,
    keepController: live && isController || !!remote && remote.phase === 'ended' && isController && controllerWindowExists,
    controlled: live && remote!.controlled === user,
  };
}
