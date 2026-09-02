import type { AppliedField, Application, ApplyStatus, Job } from '../engine/types';
import type { Profile } from '../config/schema';
import type { Site } from '../sites';
import type { ApplyOutcome, OtpOutcome } from '../platform/messaging';
import type { SerializedFile } from '../platform/serialized-file';
import { selectJobs } from '../engine/select-jobs';

// The application layer (a use-case interactor). Pure orchestration over injected ports —
// no chrome, no DOM, no network here, so it's unit-testable with fakes. Main (background)
// supplies the concrete ports. This is the Dependency Rule: details plug into policy.
export interface RunPorts {
  discover(site: Site, profile: Profile): Promise<Job[]>;
  appliedIds(): Promise<Set<string>>;
  openJob(url: string): Promise<number>; // -> tabId
  apply(site: Site, tabId: number, profile: Profile, job: Job, resume: SerializedFile): Promise<ApplyOutcome>;
  seenOtps(): Promise<string[]>; // codes already in Gmail (stale) — snapshot before submitting
  getOtp(exclude: readonly string[]): Promise<string | null>;
  sendOtp(tabId: number, code: string, autoSubmit: boolean): Promise<OtpOutcome>;
  capture(tabId: number): Promise<string | null>; // PNG dataURL of the worker tab, best-effort
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
  const queue = selectJobs(await ports.discover(site, profile), profile.want).filter((j) => !already.has(j.id));

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

export async function applyOne(
  site: Site,
  job: Job,
  profile: Profile,
  resume: SerializedFile,
  ports: RunPorts,
): Promise<Application> {
  try {
    const tabId = await ports.openJob(job.url);
    // Snapshot the codes already in Gmail BEFORE we submit — the fresh code this apply triggers
    // isn't there yet, so anything we see now is a stale leftover to exclude when polling.
    const staleCodes = await ports.seenOtps().catch(() => [] as string[]);
    const res = await ports.apply(site, tabId, profile, job, resume);
    // Snapshot the form once it's filled — the confirmation/OTP screen if we submitted,
    // otherwise the filled form. Best-effort: a capture failure must never fail the apply.
    const shot = await ports.capture(tabId).catch(() => null);
    const rec = (status: ApplyStatus, note?: string): Application =>
      mk(site, job, ports.today(), status, note, res.filled, shot);

    if (res.status === 'parked') return rec('parked', res.note);
    if (res.status === 'error') return mk(site, job, ports.today(), 'failed', res.note);
    if (res.status === 'submitted') return rec('applied', res.note);

    // needs_otp: at-least-once + idempotency (Ch10: you cannot have exactly-once delivery).
    const code = await ports.getOtp(staleCodes);
    if (!code) return rec('parked', 'OTP not found (is Gmail open?)');
    const otp = await ports.sendOtp(tabId, code, profile.auto_submit);
    const shot2 = await ports.capture(tabId).catch(() => null);
    const rec2 = (status: ApplyStatus, note?: string): Application =>
      mk(site, job, ports.today(), status, note, res.filled, shot2 ?? shot);
    if (otp.status === 'submitted') return rec2('applied');
    if (otp.status === 'ready') return rec2('parked', 'Filled + code entered; awaiting your submit');
    return rec2('failed', otp.note);
  } catch (e) {
    return mk(site, job, ports.today(), 'failed', String((e as Error).message));
  }
}

function mk(
  site: Site,
  job: Job,
  date: string,
  status: ApplyStatus,
  note?: string,
  fields?: readonly AppliedField[],
  screenshot?: string | null,
): Application {
  return {
    company: site.id, jobId: job.id, title: job.title, url: job.url, date, status, note,
    ...(fields && fields.length ? { fields } : {}),
    ...(screenshot ? { screenshot } : {}),
  };
}
