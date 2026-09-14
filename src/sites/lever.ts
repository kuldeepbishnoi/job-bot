import type { Site } from './site';
import { boardsToWalk, discoverLever } from '../sources/lever';
import { submittedByNavigation } from '../ats/lever';

// Every Lever company at once: curated defaults + profile.lever.boards. Lever's submit navigates
// to /thanks, which kills the content script — the closed port + that URL is the success signal.
export const lever: Site = {
  id: 'lever',
  label: 'Lever boards',
  ats: 'lever',
  discover: (profile) => discoverLever(boardsToWalk(profile.lever)),
  submittedUrl: submittedByNavigation,
};
