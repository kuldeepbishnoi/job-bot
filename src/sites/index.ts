import type { Site } from './site';
import { datadog } from './datadog';
import { amazon } from './amazon';

// Register site packs here. Adding Netflix/Alibaba later = one import + one line.
export const SITES: readonly Site[] = [datadog, amazon];

export function siteById(id: string): Site | undefined {
  return SITES.find((s) => s.id === id);
}

export type { Site };
