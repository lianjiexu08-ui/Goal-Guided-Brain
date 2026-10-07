/** Existing-team scenarios explicitly start after owner confirmation. */
export function seedConfirmedDefaultTeam(store) {
  const team = store.teamSpaces()[0];
  return store.saveTeamSpace(
    {
      ...team,
      memberRoleIds: ['project_manager', 'product', 'developer', 'assistant'],
      recruitment: {
        ...team.recruitment,
        phase: 'confirmed',
        confirmedAt: new Date().toISOString(),
      },
    },
    team.id,
  );
}
