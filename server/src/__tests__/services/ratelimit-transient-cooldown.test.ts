import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';

// Transient-failure cooldown configurability. TRANSIENT_COOLDOWN_MS used to be
// a bare 90s constant with no override: a single-key model with no sibling to
// fail over to turned a ~73s transport blip ("fetch failed" — a non-quota
// error, so it never enters the escalation ladder) into a repeated 90s bench
// that a burst of consecutive failures kept re-arming, well past the nominal
// 90s. getTransientCooldownMs() makes the base configurable, matching the
// settings-then-env-then-default precedence already used by
// getFallbackTimeBudgetMs (lib/fallback-loop.ts) and providerTimeoutMs
// (lib/provider-timeout.ts).

import { initDb, getDb, getSetting, setSetting } from '../../db/index.js';
import {
  getTransientCooldownMs,
  getCooldownDurationForLimit,
  setCooldownCeilingMs,
} from '../../services/ratelimit.js';

const TRANSIENT_COOLDOWN_SETTING = 'transient_cooldown_ms';
const DEFAULT_TRANSIENT_COOLDOWN_MS = 90 * 1000;

let keySeq = 953_000;
function nextKeyId(): number {
  return ++keySeq;
}

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

beforeEach(() => {
  delete process.env.TRANSIENT_COOLDOWN_MS;
  getDb().prepare(`DELETE FROM settings WHERE key = '${TRANSIENT_COOLDOWN_SETTING}'`).run();
  setCooldownCeilingMs(null);
});
afterEach(() => {
  delete process.env.TRANSIENT_COOLDOWN_MS;
  getDb().prepare(`DELETE FROM settings WHERE key = '${TRANSIENT_COOLDOWN_SETTING}'`).run();
  setCooldownCeilingMs(null);
});

describe('getTransientCooldownMs', () => {
  it('defaults to 90s when neither the setting nor the env var is present', () => {
    expect(getTransientCooldownMs()).toBe(DEFAULT_TRANSIENT_COOLDOWN_MS);
  });

  it('the env var overrides the default', () => {
    process.env.TRANSIENT_COOLDOWN_MS = '12345';
    expect(getTransientCooldownMs()).toBe(12345);
  });

  it('the settings-table value wins over the env var', () => {
    process.env.TRANSIENT_COOLDOWN_MS = '12345';
    setSetting(TRANSIENT_COOLDOWN_SETTING, '999');
    expect(getTransientCooldownMs()).toBe(999);
  });

  it('accepts 0 as a real override (no bench)', () => {
    process.env.TRANSIENT_COOLDOWN_MS = '0';
    expect(getTransientCooldownMs()).toBe(0);
  });

  it('falls through a malformed setting to the env var, then to the default', () => {
    setSetting(TRANSIENT_COOLDOWN_SETTING, 'not-a-number');
    process.env.TRANSIENT_COOLDOWN_MS = '5000';
    expect(getTransientCooldownMs()).toBe(5000);

    delete process.env.TRANSIENT_COOLDOWN_MS;
    expect(getTransientCooldownMs()).toBe(DEFAULT_TRANSIENT_COOLDOWN_MS);
  });

  it('ignores a negative override the same way getFallbackTimeBudgetMs does', () => {
    process.env.TRANSIENT_COOLDOWN_MS = '-1';
    expect(getTransientCooldownMs()).toBe(DEFAULT_TRANSIENT_COOLDOWN_MS);
  });

  it('is picked up by getCooldownDurationForLimit for a null-limits transient failure', () => {
    setSetting(TRANSIENT_COOLDOWN_SETTING, '5000');
    const id = nextKeyId();
    expect(
      getCooldownDurationForLimit('groq', `transient-cfg-${id}`, id, { rpd: null, tpd: null }, undefined, { quotaSignal: false }),
    ).toBe(5000);
  });

  it('is NOT capped by the operator cooldown ceiling (direct configuration is the intended lever)', () => {
    setCooldownCeilingMs(60_000); // ceiling below the 90s default
    expect(getTransientCooldownMs()).toBe(DEFAULT_TRANSIENT_COOLDOWN_MS);
    const id = nextKeyId();
    expect(
      getCooldownDurationForLimit('groq', `transient-ceiling-${id}`, id, { rpd: null, tpd: null }, undefined, { quotaSignal: false }),
    ).toBe(DEFAULT_TRANSIENT_COOLDOWN_MS);
  });

  it('applies a configured 0 end-to-end: a transport failure benches for 0ms', () => {
    setSetting(TRANSIENT_COOLDOWN_SETTING, '0');
    const id = nextKeyId();
    expect(
      getCooldownDurationForLimit('groq', `transient-zero-${id}`, id, { rpd: null, tpd: null }, undefined, { quotaSignal: false }),
    ).toBe(0);
  });

  it('still honors an upstream Retry-After when the configured base is 0', () => {
    // The docs promise "0 disables the self-chosen bench" — not "ignore the
    // provider": retryAfterMs > base (0) wins, same as against the 90s default.
    setSetting(TRANSIENT_COOLDOWN_SETTING, '0');
    const id = nextKeyId();
    expect(
      getCooldownDurationForLimit('groq', `transient-retryafter-${id}`, id, { rpd: null, tpd: null }, 30_000, { quotaSignal: false }),
    ).toBe(30_000);
  });
});
