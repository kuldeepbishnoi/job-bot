import { describe, it, expect } from 'vitest';
import { run, type RunPorts } from '@/app/runner';
import { parseProfile } from '@/config/schema';
import type { Application, Job } from '@/engine/types';
import type { Site } from '@/sites';
import type { ApplyOutcome, OtpOutcome } from '@/platform/messaging';

const site = { id: 'test', label: 'Test', ats: 'greenhouse', discover: async () => [] } as unknown as Site;
const profile = parseProfile({
  identity: { first_name: 'K', last_name: 'B', email: 'k@x.com', phone: '+1', country: 'India' },
  resume: 'resume/cv.pdf',
  want: {},
  answers: {},
  auto_submit: true,
});
const resume = { name: 'cv.pdf', type: 'application/pdf', dataBase64: '' };

const job = (id: string): Job => ({
  id, title: `Job ${id}`, team: '', department: 'Engineering', url: `https://x/${id}`, locations: [], seniority: [],
});

// A recording fake of the effect ports.
function fakePorts(
  cfg: { jobs: Job[]; apply: RunPorts['apply'] } & Partial<RunPorts>,
): { ports: RunPorts; recorded: Application[] } {
  const { jobs, apply, ...overrides } = cfg;
  const recorded: Application[] = [];
  const ports: RunPorts = {
    discover: async () => jobs,
    appliedIds: async () => new Set<string>(),
    openJob: async () => 1,
    apply,
    getOtp: async () => '12345678',
    sendOtp: async (): Promise<OtpOutcome> => ({ status: 'submitted' }),
    record: async (a) => void recorded.push(a),
    progress: () => {},
    cleanup: async () => {},
    today: () => '2026-07-11',
    wait: async () => {},
    ...overrides,
  };
  return { ports, recorded };
}

describe('runner (fake ports)', () => {
  it('records applied for a clean submit', async () => {
    const { ports, recorded } = fakePorts({ jobs: [job('1')], apply: async () => ({ status: 'submitted' }) });
    await run(site, profile, resume, ports);
    expect(recorded).toEqual([expect.objectContaining({ jobId: '1', status: 'applied' })]);
  });

  it('does the OTP dance when the form needs a code', async () => {
    const { ports, recorded } = fakePorts({
      jobs: [job('1')],
      apply: async (): Promise<ApplyOutcome> => ({ status: 'needs_otp' }),
    });
    await run(site, profile, resume, ports);
    expect(recorded[0]?.status).toBe('applied');
  });

  it('parks a job when a required answer is missing', async () => {
    const { ports, recorded } = fakePorts({
      jobs: [job('1')],
      apply: async (): Promise<ApplyOutcome> => ({ status: 'parked', note: 'missing X' }),
    });
    await run(site, profile, resume, ports);
    expect(recorded[0]).toMatchObject({ status: 'parked', note: 'missing X' });
  });

  it('skips jobs already applied to', async () => {
    const { ports, recorded } = fakePorts({ jobs: [job('1'), job('2')], apply: async () => ({ status: 'submitted' }) });
    ports.appliedIds = async () => new Set(['1']);
    await run(site, profile, resume, ports);
    expect(recorded.map((r) => r.jobId)).toEqual(['2']);
  });
});
