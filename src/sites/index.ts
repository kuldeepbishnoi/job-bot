import type { Site } from './site';
import { datadog } from './datadog';
import { amazon } from './amazon';
import { greenhouse } from './greenhouse';
import { lever } from './lever';
import { ashby } from './ashby';

// Register site packs here. A single-company pack is one line; the board packs (greenhouse /
// lever / ashby) each cover every company in their default list + the user's own.
export const SITES: readonly Site[] = [datadog, amazon, greenhouse, lever, ashby];

export function siteById(id: string): Site | undefined {
  return SITES.find((s) => s.id === id);
}

export type { Site };
