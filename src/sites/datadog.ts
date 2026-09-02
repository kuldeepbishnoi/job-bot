import type { Site } from './site';
import { discoverDatadogJobs } from '../sources/typesense';

export const datadog: Site = {
  id: 'datadog',
  label: 'Datadog',
  ats: 'greenhouse',
  discover: () => discoverDatadogJobs(),
};
