/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ launch: vi.fn(), close: vi.fn() }));
vi.mock('../../../lib/services/extractor/puppeteerExtractor.js', () => ({
  launchBrowser: mocks.launch,
  closeBrowser: mocks.close,
}));
import { createProviderBrowserPool } from '../../../lib/services/extractor/providerBrowserPool.js';

beforeEach(() => {
  mocks.launch.mockReset().mockImplementation(async () => ({ connected: true }));
  mocks.close.mockReset().mockResolvedValue(undefined);
});

describe('provider browser pool', () => {
  it('does not launch anything before it is needed', async () => {
    await createProviderBrowserPool().close();
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it('reuses one browser per engine across concurrent calls and forwards the proxy', async () => {
    const pool = createProviderBrowserPool({ proxyUrl: 'http://proxy.example:8080' });
    const [chrome, firefox, chromeAgain, firefoxAgain] = await Promise.all([
      pool.get({}, 'https://example.com'),
      pool.get({ browserEngine: 'firefox' }, 'https://www.funda.nl'),
      pool.get({}, 'https://example.org'),
      pool.get({ browserEngine: 'firefox' }, 'https://www.funda.nl'),
    ]);
    expect(chrome).toBe(chromeAgain);
    expect(firefox).toBe(firefoxAgain);
    expect(chrome).not.toBe(firefox);
    expect(mocks.launch.mock.calls).toEqual([
      ['https://example.com', { proxyUrl: 'http://proxy.example:8080' }],
      ['https://www.funda.nl', { proxyUrl: 'http://proxy.example:8080', browserEngine: 'firefox' }],
    ]);
    await pool.close();
    expect(mocks.close).toHaveBeenCalledTimes(2);
    expect(mocks.close).toHaveBeenCalledWith(chrome);
    expect(mocks.close).toHaveBeenCalledWith(firefox);
  });

  it('replaces a disconnected browser once even if several callers notice it', async () => {
    const pool = createProviderBrowserPool();
    const browser = await pool.get({}, 'https://example.com');
    browser.connected = false;
    const [first, second] = await Promise.all([
      pool.get({}, 'https://example.com'),
      pool.get({}, 'https://example.com'),
    ]);
    expect(first).toBe(second);
    expect(first).not.toBe(browser);
    expect(mocks.launch).toHaveBeenCalledTimes(2);
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith(browser);
    await pool.close();
  });

  it('waits for an in-flight launch before closing it', async () => {
    let resolve;
    mocks.launch.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pool = createProviderBrowserPool();
    const pending = pool.get({}, 'https://example.com');
    await Promise.resolve();
    const closing = pool.close();
    const browser = { connected: true };
    resolve(browser);
    await pending;
    await closing;
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith(browser);
  });

  it('still closes the other engine when a launch fails', async () => {
    mocks.launch.mockResolvedValueOnce({ connected: true }).mockRejectedValueOnce(new Error('Firefox missing'));
    const pool = createProviderBrowserPool();
    const browser = await pool.get({}, 'https://example.com');
    await expect(pool.get({ browserEngine: 'firefox' }, 'https://www.funda.nl')).rejects.toThrow('Firefox missing');
    await pool.close();
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith(browser);
  });
});
