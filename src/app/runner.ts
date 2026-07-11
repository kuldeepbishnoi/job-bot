import type { Application, Job } from '../engine/types';
import type { Profile } from '../config/schema';
import type { Site } from '../sites';
import type { ApplyOutcome, OtpOutcome } from '../platform/messaging';
import type { SerializedFile } from '../platform/serialized-file';
import { selectJobs } from '../engine/select-jobs';

// The application layer (a use-case interactor). Pure orchestration over injected ports —
// no chrome, no DOM, no network here, so it's unit-testable with fakes. Main (background)
// supplies the concrete ports. This is the Dependency Rule: details plug into policy.
export interface RunPorts {
  discover(site: Site): Promise<Job[]>;
  appliedIds(): Promise<Set<string>>;
  openJob(url: string): Promise<number>; // -> tabId
  apply(tabId: number, profile: Profile, job: Job, resume: SerializedFile): Promise<ApplyOutcome>;
  getOtp(): Promise<string | null>;
  sendOtp(tabId: number, code: string, autoSubmit: boolean): Promise<OtpOutcome>;
  record(app: Application): Promise<void>;
  progress(done: number, total: number, current: string): void;
  cleanup(): Promise<void>;
  today(): string; // ISO yyyy-mm-dd
  wait(ms: number): Promise<void>;
}

const PACE_MS = 20_000; // gap between jobs — human-like, avoids rate flags (Ch4/Ch9: politeness)

export async function run(
  site: Site,
  profile: Profile,
  resume: SerializedFile,
  ports: RunPorts,
): Promise<void> {
  const already = await ports.appliedIds();
  const queue = selectJobs(await ports.discover(site), profile.want).filter((j) => !already.has(j.id));

  try {
    for (let done = 0; done < queue.length; done++) {
      const job = queue[done]!;
      ports.progress(done, queue.length, job.title);
      await ports.record(await applyOne(site, job, profile, resume, ports));
      await ports.wait(PACE_MS);
    }
  } finally {
    await ports.cleanup();
  }
}

async function applyOne(
  site: Site,
  job: Job,
  profile: Profile,
  resume: SerializedFile,
  ports: RunPorts,
): Promise<Application> {
  try {
    const tabId = await ports.openJob(job.url);
    const res = await ports.apply(tabId, profile, job, resume);

    if (res.status === 'parked') return mk(site, job, ports.today(), 'parked', res.note);
    if (res.status === 'error') return mk(site, job, ports.today(), 'failed', res.note);
    if (res.status === 'submitted') return mk(site, job, ports.today(), 'applied');

    // needs_otp: at-least-once + idempotency (Ch10: you cannot have exactly-once delivery).
    const code = await ports.getOtp();
    if (!code) return mk(site, job, ports.today(), 'parked', 'OTP not found (is Gmail open?)');
    const otp = await ports.sendOtp(tabId, code, profile.auto_submit);
    if (otp.status === 'submitted') return mk(site, job, ports.today(), 'applied');
    if (otp.status === 'ready') return mk(site, job, ports.today(), 'parked', 'Filled + code entered; awaiting your submit');
    return mk(site, job, ports.today(), 'failed', otp.note);
  } catch (e) {
    return mk(site, job, ports.today(), 'failed', String((e as Error).message));
  }
}

function mk(site: Site, job: Job, date: string, status: Application['status'], note?: string): Application {
  return { company: site.id, jobId: job.id, title: job.title, url: job.url, date, status, note };
}
