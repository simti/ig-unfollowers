'use strict';

const logger = require('./logger');

const BASE = 'https://www.instagram.com';

/**
 * Usernames are stored lowercase, without a leading @, without whitespace.
 * Instagram handles are case-insensitive but canonically lowercase.
 */
function normalizeUsername(u) {
  return String(u || '').trim().toLowerCase().replace(/^@+/, '');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Check whether the current page shows a logged-in Instagram session.
 */
async function isLoggedIn(page) {
  return page.evaluate(() => {
    // The login form shows input[name="username"]; when logged in it's absent
    // and a navigation rail / "New post" button is present.
    if (document.querySelector('input[name="username"]')) return false;
    const navIndicators = [
      'a[href="/direct/inbox/"]',
      'svg[aria-label="New post"]',
      'svg[aria-label="Home"]',
    ];
    return navIndicators.some((sel) => document.querySelector(sel));
  });
}

/**
 * Ensure the session is authenticated. If credentials are provided, attempts
 * automated login. Otherwise opens a window and waits for the user to log in.
 */
async function ensureLoggedIn(page, { username, password, manualTimeoutMs = 5 * 60 * 1000 }) {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });

  if (await isLoggedIn(page)) {
    logger.info('Session already authenticated');
    return;
  }

  if (username && password) {
    logger.info('Attempting automated login', { username });
    await page.waitForSelector('input[name="username"]', { timeout: 30000 });
    await page.fill('input[name="username"]', username);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');

    // Wait for either the login form to disappear or a known challenge to appear.
    try {
      await page.waitForFunction(
        () => !document.querySelector('input[name="password"]'),
        { timeout: 60000 }
      );
    } catch {
      throw new Error('Login did not complete within 60s (possible 2FA / checkpoint).');
    }
  }

  if (await isLoggedIn(page)) {
    logger.info('Login successful');
    return;
  }

  logger.warn(
    `Automated login not completed. Please log in manually in the opened browser window ` +
      `(handling any 2FA / security prompts). Waiting up to ${Math.round(manualTimeoutMs / 1000)}s...`
  );

  const deadline = Date.now() + manualTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(2000);
    if (await isLoggedIn(page)) {
      logger.info('Manual login detected');
      return;
    }
  }
  throw new Error('Timed out waiting for manual login.');
}

/**
 * Dismiss common Instagram interstitials ("Save your login info", notifications, cookie banners).
 */
async function dismissInterstitials(page) {
  const candidates = [
    'button:has-text("Not now")',
    'button:has-text("Not Now")',
    'button:has-text("Not now, thanks")',
    'button:has-text("Only allow essential cookies")',
    'button:has-text("Allow all cookies")',
    'button:has-text("Decline optional cookies")',
  ];
  for (const sel of candidates) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
        await btn.click({ timeout: 1500 }).catch(() => {});
        await sleep(300);
      }
    } catch {
      /* ignore */
    }
  }
}

/**
 * Open the followers or following dialog. Uses the in-profile link to trigger
 * the UI that Instagram expects, rather than navigating directly to the URL
 * (direct navigation sometimes returns a login wall).
 */
async function openListDialog(page, profileUsername, listType) {
  const profileUrl = `${BASE}/${profileUsername}/`;
  logger.info('Opening profile', { profileUrl });
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
  await dismissInterstitials(page);

  // The followers/following buttons are <a> tags with hrefs ending in
  // /followers/ or /following/. Multiple possible selectors in case of A/B tests.
  const selectors = [
    `a[href="/${profileUsername}/${listType}/"]`,
    `a[href$="/${listType}/"]`,
  ];

  let clicked = false;
  for (const sel of selectors) {
    const link = page.locator(sel).first();
    if (await link.count()) {
      await link.scrollIntoViewIfNeeded().catch(() => {});
      await link.click({ timeout: 10000 }).catch(() => {});
      clicked = true;
      break;
    }
  }

  if (!clicked) {
    // Fallback: direct URL (works in most logged-in cases).
    logger.warn('Follower link not found via selector, falling back to direct URL');
    await page.goto(`${profileUrl}${listType}/`, { waitUntil: 'domcontentloaded' });
  }

  const dialog = page.locator('div[role="dialog"]').first();
  await dialog.waitFor({ state: 'visible', timeout: 30000 });
  return dialog;
}

/**
 * Scrape one list (followers or following) by combining two strategies:
 *   1) Intercept Instagram's internal JSON responses (stable structure, fast).
 *   2) Scrape anchor hrefs inside the dialog as a DOM fallback.
 */
async function scrapeList({
  page,
  profileUsername,
  listType,
  idleScrollLimit,
  maxScrollIterations,
  scrollDelayMs,
}) {
  if (listType !== 'followers' && listType !== 'following') {
    throw new Error(`Invalid listType: ${listType}`);
  }

  const collected = new Set();
  let networkHits = 0;

  const onResponse = async (response) => {
    const url = response.url();
    if (!url.includes('/api/v1/friendships/')) return;
    const matchesList =
      (listType === 'followers' && /\/friendships\/\d+\/followers\//.test(url)) ||
      (listType === 'following' && /\/friendships\/\d+\/following\//.test(url));
    if (!matchesList) return;

    try {
      const body = await response.json();
      const users = Array.isArray(body?.users) ? body.users : [];
      for (const u of users) {
        if (u && typeof u.username === 'string') {
          collected.add(normalizeUsername(u.username));
        }
      }
      networkHits += 1;
    } catch (err) {
      logger.debug('Could not parse friendships response as JSON', { url, error: err.message });
    }
  };

  page.on('response', onResponse);

  try {
    const dialog = await openListDialog(page, profileUsername, listType);

    // Give the dialog a moment to mount & fire its first request.
    await sleep(1500);

    let idleCycles = 0;
    let lastSize = 0;

    for (let i = 0; i < maxScrollIterations; i++) {
      // Scroll the scrollable descendant of the dialog. Finding it dynamically
      // avoids relying on brittle class selectors.
      await page.evaluate(() => {
        const dlg = document.querySelector('div[role="dialog"]');
        if (!dlg) return;
        let scrollable = null;
        let maxHeight = 0;
        for (const el of dlg.querySelectorAll('*')) {
          const style = getComputedStyle(el);
          const canScroll =
            (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
            el.scrollHeight > el.clientHeight + 4;
          if (canScroll && el.scrollHeight > maxHeight) {
            scrollable = el;
            maxHeight = el.scrollHeight;
          }
        }
        if (scrollable) {
          scrollable.scrollTop = scrollable.scrollHeight;
        }
      });

      // Nudge with wheel events too; some builds of IG only paginate on wheel.
      try {
        const box = await dialog.boundingBox();
        if (box) {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height - 20);
          await page.mouse.wheel(0, 2000);
        }
      } catch {
        /* ignore */
      }

      await sleep(scrollDelayMs + Math.floor(Math.random() * 600));

      if (collected.size === lastSize) {
        idleCycles += 1;
        if (idleCycles >= idleScrollLimit) {
          logger.info('Reached end of list', { listType, size: collected.size });
          break;
        }
      } else {
        idleCycles = 0;
        lastSize = collected.size;
        if (i % 5 === 0) {
          logger.info('Scrolling...', { listType, collected: collected.size });
        }
      }
    }

    // DOM fallback: collect usernames from anchor hrefs inside the dialog.
    // Captures anything the network interceptor may have missed (e.g. server-rendered first batch).
    const domUsernames = await page.$$eval(
      'div[role="dialog"] a[role="link"]',
      (links) => {
        const skip = new Set([
          'explore', 'p', 'reels', 'stories', 'direct', 'accounts',
          'tv', 'challenge', 'legal', 'about', 'developer',
        ]);
        const out = [];
        for (const a of links) {
          const href = a.getAttribute('href') || '';
          const m = href.match(/^\/([^/?#]+)\/?$/);
          if (m && !skip.has(m[1])) out.push(m[1]);
        }
        return out;
      }
    );
    for (const u of domUsernames) collected.add(normalizeUsername(u));

    logger.info('List scrape finished', {
      listType,
      size: collected.size,
      networkResponses: networkHits,
    });

    // Close the dialog before moving on.
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(500);

    return collected;
  } finally {
    page.off('response', onResponse);
  }
}

module.exports = {
  normalizeUsername,
  ensureLoggedIn,
  scrapeList,
};
