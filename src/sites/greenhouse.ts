import type { Site } from './site';
import { boardsToWalk, discoverGreenhouseBoards } from '../sources/greenhouse-boards';

// Every Greenhouse company at once: the curated default boards + profile.greenhouse.boards, all
// filled by the same ats/greenhouse.ts that Datadog uses (hosted page instead of the embed).
export const greenhouse: Site = {
  id: 'greenhouse',
  label: 'Greenhouse boards',
  ats: 'greenhouse',
  discover: (profile) => discoverGreenhouseBoards(boardsToWalk(profile.greenhouse)),
};
