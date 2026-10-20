/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { launchBrowser, closeBrowser } from './puppeteerExtractor.js';

/**
 * A run-scoped lazy browser pool, one instance per engine. Providers normally share Chromium;
 * a provider requesting Firefox must never be handed that Chromium (or vice versa). Promises are
 * cached before launching so concurrent probes cannot start duplicate browsers. Every launch is
 * awaited during cleanup, including failed/in-flight launches. Proxy settings apply to both engines.
 * @param {{proxyUrl?: string}} [settings] The current global browser settings.
 * @returns {{get: (config: {browserEngine?: string}, url: string) => Promise<any>, close: () => Promise<void>}}
 */
export function createProviderBrowserPool(settings = {}) {
  const browsers = new Map();
  const get = (config, url) => {
    const engine = config?.browserEngine ?? 'chromium';
    const options = {
      ...(settings.proxyUrl ? { proxyUrl: settings.proxyUrl } : {}),
      ...(engine === 'firefox' ? { browserEngine: engine } : {}),
    };
    const current = browsers.get(engine);
    if (!current) {
      const promise = Promise.resolve().then(() => launchBrowser(url, options));
      browsers.set(engine, promise);
      return promise;
    }
    return current.then((browser) => {
      if (browser?.connected !== false) return browser;
      if (browsers.get(engine) !== current) return get(config, url);
      const replacement = closeBrowser(browser).then(() => launchBrowser(url, options));
      browsers.set(engine, replacement);
      return replacement;
    });
  };
  return {
    get,
    close: async () => {
      await Promise.all([...browsers.values()].map((promise) => promise.then(closeBrowser).catch(() => {})));
      browsers.clear();
    },
  };
}
