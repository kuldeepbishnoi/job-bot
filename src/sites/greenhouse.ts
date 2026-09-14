import type { Site } from './site';
import { boardsToWalk, discoverGreenhouseBoards } from '../sources/greenhouse-boards';

// Every Greenhouse company the user names at once, filled by the same ats/greenhouse.ts that
// Datadog uses (hosted page instead of the embed). Runs exactly what's listed — the curated
// ~126-company default list is opt-in (include_defaults: true) since this pack APPLIES, not just
// discovers: a one-click "Apply for Greenhouse boards" must never fan out to companies the user
// never named, especially with auto_submit on.
export const greenhouse: Site = {
  id: 'greenhouse',
  label: 'Greenhouse boards',
  ats: 'greenhouse',
  discover: async (profile) => {
    const boards = boardsToWalk(profile.greenhouse);
    if (boards.length === 0) throw new Error('no boards configured — add profile.greenhouse.boards, or set include_defaults: true to use the curated list');
    return discoverGreenhouseBoards(boards);
  },
};
