/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ launch: vi.fn(), exists: vi.fn() }));
vi.mock('puppeteer-core', () => ({ launch: mocks.launch }));
vi.mock('node:fs', () => ({ existsSync: mocks.exists }));
import { launchFirefox, firefoxProxyPrefs } from '../../../lib/services/extractor/firefoxBrowser.js';

beforeEach(() => {
  mocks.launch.mockReset().mockResolvedValue({ connected: true });
  mocks.exists.mockReset().mockImplementation((path) => path === '/usr/bin/firefox-esr');
  vi.stubEnv('FREDY_FIREFOX_EXECUTABLE', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('stock Firefox launch', () => {
  it('uses Firefox BiDi with a fresh temporary profile, not the personal browser', async () => {
    await launchFirefox();
    const options = mocks.launch.mock.calls[0][0];
    expect(options).toMatchObject({ browser: 'firefox', executablePath: '/usr/bin/firefox-esr', headless: true });
    expect(options.userDataDir).toBeUndefined();
    expect(options).not.toHaveProperty('profile');
    expect(options).not.toHaveProperty('args');
  });

  it('allows a configured executable, but does not silently ignore a broken override', async () => {
    vi.stubEnv('FREDY_FIREFOX_EXECUTABLE', '/custom/firefox');
    mocks.exists.mockImplementation((path) => path === '/custom/firefox');
    await launchFirefox();
    expect(mocks.launch.mock.calls[0][0].executablePath).toBe('/custom/firefox');
    mocks.exists.mockReturnValue(false);
    await expect(launchFirefox()).rejects.toThrow('Firefox is required');
  });

  it('does not launch a browser if Firefox is missing', async () => {
    mocks.exists.mockReturnValue(false);
    await expect(launchFirefox()).rejects.toThrow('Rebuild the Docker image');
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it('honors supplied timeout, language and timezone without patching navigator', async () => {
    await launchFirefox({ puppeteerTimeout: 1234, acceptLanguage: 'nl-NL,nl;q=0.9', timezone: 'Europe/Amsterdam' });
    expect(mocks.launch.mock.calls[0][0]).toMatchObject({
      timeout: 1234,
      extraPrefsFirefox: { 'intl.accept_languages': 'nl-NL,nl' },
      env: { TZ: 'Europe/Amsterdam' },
    });
  });
});

describe('Firefox proxy safety', () => {
  it('does not configure a proxy unless one was requested', () => {
    expect(firefoxProxyPrefs()).toEqual({});
    expect(firefoxProxyPrefs('   ')).toEqual({});
  });

  it('routes HTTP and HTTPS destinations through the configured HTTP proxy', () => {
    expect(firefoxProxyPrefs('http://proxy.example:8080')).toMatchObject({
      'network.proxy.type': 1,
      'network.proxy.http': 'proxy.example',
      'network.proxy.http_port': 8080,
      'network.proxy.ssl': 'proxy.example',
      'network.proxy.ssl_port': 8080,
      'network.proxy.no_proxies_on': '',
      'network.proxy.failover_direct': false,
    });
  });

  it('keeps SOCKS5 DNS at the proxy', () => {
    expect(firefoxProxyPrefs('socks5://proxy.example:1081')).toMatchObject({
      'network.proxy.socks': 'proxy.example',
      'network.proxy.socks_port': 1081,
      'network.proxy.socks_version': 5,
      'network.proxy.socks_remote_dns': true,
      'network.proxy.failover_direct': false,
    });
  });

  it.each([
    'https://proxy.example:443',
    'http://user:password@proxy.example:8080',
    'socks5://user:password@proxy.example:1080',
    'not-a-url',
    'http://proxy.example/path',
  ])('refuses unsupported proxy settings before launching: %s', async (proxyUrl) => {
    await expect(launchFirefox({ proxyUrl })).rejects.toThrow(/proxy/i);
    expect(mocks.launch).not.toHaveBeenCalled();
  });
});
