import type { Site } from './site';
import { boardsToWalk, discoverAshby } from '../sources/ashby';

// Every Ashby company the user names at once. Runs exactly what's listed — the curated default
// list is opt-in (include_defaults: true), since this pack applies rather than just discovers.
export const ashby: Site = {
  id: 'ashby',
  label: 'Ashby boards',
  ats: 'ashby',
  discover: async (profile) => {
    const boards = boardsToWalk(profile.ashby);
    if (boards.length === 0) throw new Error('no boards configured — add profile.ashby.boards, or set include_defaults: true to use the curated list');
    return discoverAshby(boards);
  },
};
