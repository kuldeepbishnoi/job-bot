import type { Site } from './site';
import { boardsToWalk, discoverAshby } from '../sources/ashby';

// Every Ashby company at once: curated defaults + profile.ashby.boards.
export const ashby: Site = {
  id: 'ashby',
  label: 'Ashby boards',
  ats: 'ashby',
  discover: (profile) => discoverAshby(boardsToWalk(profile.ashby)),
};
