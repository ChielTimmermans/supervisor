import { describe, it, expect } from 'vitest';
import { processDiagnostics } from '../src/diagnostics.js';

describe('processDiagnostics', () => {
  it('reports real memory usage in whole megabytes', () => {
    const d = processDiagnostics();
    expect(Number.isFinite(d.rssMb)).toBe(true);
    expect(d.rssMb).toBeGreaterThan(0);
    expect(Number.isFinite(d.heapUsedMb)).toBe(true);
    expect(d.heapUsedMb).toBeGreaterThan(0);
  });

  it('reports this process\'s open file descriptor count on Linux', () => {
    const d = processDiagnostics();
    expect(Number.isInteger(d.openFds)).toBe(true);
    expect(d.openFds!).toBeGreaterThan(0);
  });

  it('never throws even if a sub-probe is unavailable', () => {
    expect(() => processDiagnostics()).not.toThrow();
  });
});
