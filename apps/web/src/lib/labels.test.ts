import { finalMessage, hardwareModeLabel, verificationLabel } from './labels';
import { toApiError } from './api';

describe('labels', () => {
  it('describes verification levels in plain language', () => {
    expect(verificationLabel('SIMULATED')).toBe('Simulated (no real measurement)');
    expect(verificationLabel('ESTIMATED')).toBe('Estimated from pump timing');
    expect(verificationLabel('MASS_DELTA')).toBe('Measured by weight change');
    expect(verificationLabel('UNVERIFIED')).toBe('Not verified');
  });
  it('asks to contact staff on failures', () => {
    expect(finalMessage('FAILED')?.body).toMatch(/contact staff/);
    expect(finalMessage('SAFETY_STOPPED')?.body).toMatch(/contact staff/);
    expect(finalMessage('DISPENSING')).toBeNull();
  });
  it('labels hardware modes', () => {
    expect(hardwareModeLabel('mock').label).toMatch(/MOCK/);
    expect(hardwareModeLabel('esp32').label).toMatch(/PHYSICAL/);
  });
});

describe('toApiError', () => {
  it('passes through ApiError bodies', () => {
    const e = toApiError(422, 'x', { statusCode: 422, error: 'Unprocessable Entity', message: 'bad', details: ['a'] });
    expect(e).toMatchObject({ statusCode: 422, message: 'bad', details: ['a'] });
  });
  it('handles non-JSON bodies and network errors', () => {
    expect(toApiError(502, 'Bad Gateway', null).message).toBe('Bad Gateway');
    expect(toApiError(0, '', null).message).toMatch(/reach the server/);
  });
});
