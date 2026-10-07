import type { RouteCache, State, TeamSpace } from './model';

export function activeWorkspace(spaces: TeamSpace[], selectedId?: string) {
  const active = spaces.filter((space) => space.status !== 'archived');
  return (
    active.find((space) => space.id === selectedId) ||
    active.find((space) => space.recruitment?.phase === 'confirmed') ||
    active[0]
  );
}

/** A draft remains recruitment even when an older cache calls it a team. */
export function workspaceView(view: string, space?: TeamSpace, role?: string) {
  if (!['workspace', 'recruitment', 'team'].includes(view)) return view;
  if (
    view === 'workspace' &&
    role &&
    !['__router__', space?.pmRoleId || 'project_manager'].includes(role)
  )
    return view;
  if (!space) return view === 'workspace' ? 'recruitment' : view;
  if (space.recruitment?.phase !== 'confirmed') return 'recruitment';
  return view === 'recruitment' ? 'workspace' : view;
}

export function initialWorkspaceRoute(data: State, cached: RouteCache) {
  const space = activeWorkspace(data.spaces || [], cached.spaceId);
  const activeRoles = data.roles.filter((role) => !role.archived);
  const cachedMember =
    space?.recruitment?.phase === 'confirmed' &&
    space.memberRoleIds.includes(cached.role || '') &&
    activeRoles.some((role) => role.id === cached.role);
  return {
    spaceId: space?.id || '',
    role:
      (cachedMember ? cached.role : space?.pmRoleId) ||
      activeRoles.find((role) => role.id === 'project_manager')?.id ||
      activeRoles[0]?.id ||
      '__router__',
    view: workspaceView(cached.view || 'workspace', space),
  };
}
