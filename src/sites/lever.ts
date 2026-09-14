import type { Site } from './site';
import { boardsToWalk, discoverLever } from '../sources/lever';
import { submittedByNavigation } from '../ats/lever';

// Every Lever company the user names at once. Runs exactly what's listed — the curated default
// list is opt-in (include_defaults: true), since this pack applies rather than just discovers.
// Lever's submit navigates to /thanks, which kills the content script — the closed port + that
// URL is the success signal.
export const lever: Site = {
  id: 'lever',
  label: 'Lever boards',
  ats: 'lever',
  discover: async (profile) => {
    const boards = boardsToWalk(profile.lever);
    if (boards.length === 0) throw new Error('no boards configured — add profile.lever.boards, or set include_defaults: true to use the curated list');
    return discoverLever(boards);
  },
  submittedUrl: submittedByNavigation,
};
