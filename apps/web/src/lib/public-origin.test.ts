import { describe, expect, it, vi } from 'vitest';
const env = vi.hoisted(() => ({
  NEXTAUTH_URL: 'https://music.example.com',
  NODE_ENV: 'production',
}));
vi.mock('@/lib/env', () => ({ getEnv: () => env }));
import { publicUrl } from './public-origin';

describe('public redirects', () => {
  it('uses the configured website rather than Docker or forwarded hosts', () => {
    expect(publicUrl('/dashboard/settings?spotify=linked').href).toBe(
      'https://music.example.com/dashboard/settings?spotify=linked',
    );
  });
  it('rejects external redirects', () => {
    expect(() => publicUrl('//attacker.example/path')).toThrow();
  });
  it.each([
    'http://0.0.0.0:3000',
    'http://music.example.com',
    'https://user:pass@music.example.com',
  ])('rejects unsafe production origins: %s', (url) => {
    env.NEXTAUTH_URL = url;
    try {
      expect(() => publicUrl('/login')).toThrow();
    } finally {
      env.NEXTAUTH_URL = 'https://music.example.com';
    }
  });
});
