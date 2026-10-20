/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { existsSync } from 'node:fs';
import { launch } from 'puppeteer-core';

/**
 * Find an installed Firefox executable, never a user's profile. Docker installs firefox-esr;
 * native installations may override detection with FREDY_FIREFOX_EXECUTABLE.
 * @returns {string} An executable path.
 */
function executablePath() {
  const override = process.env.FREDY_FIREFOX_EXECUTABLE;
  const candidates = override
    ? [override]
    : [
        '/usr/bin/firefox-esr',
        '/usr/bin/firefox',
        '/usr/sbin/firefox',
        '/Applications/Firefox.app/Contents/MacOS/firefox',
        `${process.env.ProgramFiles || 'C:\\Program Files'}\\Mozilla Firefox\\firefox.exe`,
      ];
  const found = candidates.find((path) => existsSync(path));
  if (!found)
    throw new Error(
      'Firefox is required by this provider. Rebuild the Docker image, install Firefox, or set FREDY_FIREFOX_EXECUTABLE.',
    );
  return found;
}

/**
 * Translate supported proxies to native Firefox prefs. Never silently fall back to a direct
 * connection: authenticated/HTTPS proxy transport is not supported here and is refused explicitly.
 * SOCKS5 DNS stays at the proxy; no destination is exempted from the configured proxy.
 * @param {string} [value] Global proxy URL, if configured.
 * @returns {Object.<string, string|number|boolean>} Firefox proxy preferences.
 */
export function firefoxProxyPrefs(value) {
  if (!value?.trim()) return {};
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Firefox requires a valid HTTP or SOCKS5 proxy URL.');
  }
  if (
    !['http:', 'socks5:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !['', '/'].includes(url.pathname) ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Firefox supports HTTP or SOCKS5 proxies without authentication; the configured proxy cannot be used. No direct connection was attempted.',
    );
  }
  const prefs = { 'network.proxy.type': 1, 'network.proxy.no_proxies_on': '', 'network.proxy.failover_direct': false };
  if (url.protocol === 'socks5:') {
    return {
      ...prefs,
      'network.proxy.socks': url.hostname,
      'network.proxy.socks_port': Number(url.port || 1080),
      'network.proxy.socks_version': 5,
      'network.proxy.socks_remote_dns': true,
    };
  }
  return {
    ...prefs,
    'network.proxy.http': url.hostname,
    'network.proxy.http_port': Number(url.port || 80),
    'network.proxy.ssl': url.hostname,
    'network.proxy.ssl_port': Number(url.port || 80),
  };
}

/**
 * Launch stock Firefox over Puppeteer's WebDriver BiDi transport. Puppeteer creates a new temporary
 * profile and disposes of it on close: no personal session, browser history or cookies are reused.
 * @param {{proxyUrl?: string, puppeteerHeadless?: boolean, puppeteerTimeout?: number, acceptLanguage?: string, timezone?: string}} [options]
 * @returns {Promise<import('puppeteer-core').Browser>}
 */
export async function launchFirefox(options = {}) {
  const proxyPrefs = firefoxProxyPrefs(options.proxyUrl);
  return launch({
    browser: 'firefox',
    executablePath: executablePath(),
    headless: options.puppeteerHeadless ?? true,
    timeout: options.puppeteerTimeout ?? 60_000,
    ...(options.timezone ? { env: { ...process.env, TZ: options.timezone } } : {}),
    extraPrefsFirefox: {
      ...(options.acceptLanguage
        ? {
            'intl.accept_languages': options.acceptLanguage
              .split(',')
              .map((part) => part.split(';')[0])
              .join(','),
          }
        : {}),
      ...proxyPrefs,
    },
  });
}
