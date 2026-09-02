import type { Site } from './datadog';
import { datadog } from './datadog';

// Register site packs here. Adding Netflix/Alibaba later = one import + one line.
export const SITES: readonly Site[] = [datadog];

export function siteById(id: string): Site | undefined {
  return SITES.find((s) => s.id === id);
}

export type { Site };
