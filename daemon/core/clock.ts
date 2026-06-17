/**
 * Injectable clock for deterministic tests.
 *
 * Production code uses systemClock (real Date.now / performance).
 * Tests inject a FakeClock so seq, ordering, ids, and store state
 * are fully deterministic and not coupled to wall-clock timing.
 *
 * Rule: ts in events may use real wall-clock in the CLI demo,
 * but logic (seq, ordering, ids, store state) must be deterministic.
 */

export interface Clock {
  /** Unix timestamp in seconds (spec §5 ts field). */
  now(): number;
}

/** Real wall-clock: seconds since epoch (truncated). */
export const systemClock: Clock = {
  now(): number {
    return Math.floor(Date.now() / 1000);
  },
};

/** Fake clock for tests: starts at a fixed epoch, advances manually. */
export class FakeClock implements Clock {
  private _ts: number;

  constructor(startTs = 1718600000) {
    this._ts = startTs;
  }

  now(): number {
    return this._ts;
  }

  /** Advance by N seconds. */
  advance(seconds: number): void {
    this._ts += seconds;
  }

  /** Set to a specific timestamp. */
  set(ts: number): void {
    this._ts = ts;
  }
}
