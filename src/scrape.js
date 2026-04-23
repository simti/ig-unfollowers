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
 * Read the follower/following counts from the profile header. Returns
 * { followers, following } where each is a number or null if unparseable.
 * Used as a target so the scroll loop can detect under-collection and keep going.
 */
async function getProfileCounts(page, profileUsername) {
  return page.evaluate((username) => {
    const parseCount = (raw) => {
      if (!raw) return null;
      const txt = String(raw).replace(/[, ]/g, '').trim();
      const m = txt.match(/^([\d.]+)\s*([KkMmBb]?)/);
      if (!m) return null;
      let n = parseFloat(m[1]);
      const suffix = m[2].toLowerCase();
      if (suffix === 'k') n *= 1e3;
      if (suffix === 'm') n *= 1e6;
      if (suffix === 'b') n *= 1e9;
      return Math.round(n);
    };
    const readCount = (suffix) => {
      const candidates = [
        document.querySelector(`a[href="/${username}/${suffix}/"]`),
        document.querySelector(`a[href$="/${username}/${suffix}/"]`),
        document.querySelector(`header a[href$="/${suffix}/"]`),
        document.querySelector(`a[href$="/${suffix}/"]`),
      ].filter(Boolean);
      for (const a of candidates) {
        const titled = a.querySelector('[title]');
        if (titled?.title) {
          const n = parseCount(titled.title);
          if (n != null) return n;
        }
        const span = a.querySelector('span span') || a.querySelector('span');
        const n = parseCount(span?.textContent || a.textContent);
        if (n != null) return n;
      }
      return null;
    };
    return { followers: readCount('followers'), following: readCount('following') };
  }, profileUsername);
}

/**
 * Open the followers or following dialog. Tries several locators because
 * Instagram A/B-tests the markup; if every locator fails the script asks
 * the user to click the count manually and waits.
 */
async function openListDialog(page, profileUsername, listType) {
  const profileUrl = `${BASE}/${profileUsername}/`;
  logger.info('Opening profile', { profileUrl });
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
  await dismissInterstitials(page);

  // Wait for the profile header to render (the part with the post/follower counts).
  await page
    .waitForSelector('header section, header[role="banner"]', { timeout: 30000 })
    .catch(() => {});
  await sleep(1500);

  const re = new RegExp(`^\\s*[\\d.,KkMmBb]+\\s+${listType}\\s*$`, 'i');

  const candidateLocators = [
    page.locator(`a[href="/${profileUsername}/${listType}/"]`).first(),
    page.locator(`a[href$="/${profileUsername}/${listType}/"]`).first(),
    page.locator(`header a[href$="/${listType}/"]`).first(),
    page.locator(`a[href$="/${listType}/"]`).first(),
    page.getByRole('link', { name: re }).first(),
    page.getByRole('button', { name: re }).first(),
    page.getByRole('link', { name: new RegExp(listType, 'i') }).first(),
  ];

  let clicked = false;
  for (const loc of candidateLocators) {
    try {
      if (!(await loc.count())) continue;
      await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      await loc.click({ timeout: 5000 });
      clicked = true;
      logger.info('Clicked list link', { listType });
      break;
    } catch (err) {
      logger.debug('Locator click failed', { listType, error: err.message });
    }
  }

  if (!clicked) {
    // Last-ditch: try direct URL.
    logger.warn('All locators failed; trying direct URL');
    await page
      .goto(`${profileUrl}${listType}/`, { waitUntil: 'domcontentloaded' })
      .catch(() => {});
  }

  const dialog = page.locator('div[role="dialog"]').first();
  try {
    await dialog.waitFor({ state: 'visible', timeout: 8000 });
    return dialog;
  } catch {
    logger.warn(
      `>>> Could not open the "${listType}" dialog automatically. ` +
        `Please CLICK the "${listType}" count in the browser window now. ` +
        `Waiting up to 2 minutes...`
    );
    await dialog.waitFor({ state: 'visible', timeout: 120000 });
    logger.info('Dialog opened (manual click)');
    return dialog;
  }
}

/**
 * Scroll the followers/following dialog once using multiple strategies.
 * Returns the bounding box of the chosen scroller so the caller can dispatch
 * a real Playwright mouse wheel event on top of it (which is the most
 * reliable way to trigger Instagram's lazy-load on recent builds).
 */
async function scrollDialogOnce(page, profileUsername) {
  const result = await page.evaluate((self) => {
    const skip = new Set([
      'explore','p','reels','stories','direct','accounts','tv',
      'challenge','legal','about','developer', self,
    ]);
    const isProfileLink = (a) => {
      const m = (a.getAttribute('href') || '').match(/^\/([^/?#]+)\/?$/);
      return !!m && !skip.has(m[1]);
    };
    const profileLinks = (root) =>
      [...root.querySelectorAll('a[href^="/"]')].filter(isProfileLink);

    // Search the entire document for scrollables — IG sometimes renders the
    // list in a wrapper outside the dialog node.
    const candidates = [...document.querySelectorAll('div, section, ul, main')].filter(
      (el) => {
        const s = getComputedStyle(el);
        const canScroll =
          s.overflowY === 'auto' ||
          s.overflowY === 'scroll' ||
          s.overflow === 'auto' ||
          s.overflow === 'scroll';
        return canScroll && el.scrollHeight > el.clientHeight + 4;
      }
    );

    let best = null;
    let bestCount = -1;
    for (const c of candidates) {
      const n = profileLinks(c).length;
      if (n > bestCount) {
        best = c;
        bestCount = n;
      }
    }
    // If nothing has profile links yet (very first frame), fall back to the
    // tallest scrollable.
    if (!best || bestCount === 0) {
      let tallest = null;
      let tallestH = 0;
      for (const c of candidates) {
        if (c.scrollHeight > tallestH) {
          tallest = c;
          tallestH = c.scrollHeight;
        }
      }
      best = tallest || best;
    }

    if (!best) {
      return { ok: false, reason: 'no_scrollable', candidates: candidates.length };
    }

    const before = best.scrollTop;
    const links = profileLinks(best);

    // Strategy A: scrollIntoView on the last profile row.
    if (links.length > 0) {
      links[links.length - 1].scrollIntoView({ block: 'end', behavior: 'instant' });
    }
    // Strategy B: assign scrollTop to scrollHeight.
    best.scrollTop = best.scrollHeight;
    // Strategy C: synthetic wheel event dispatched on the element.
    best.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: Math.max(best.clientHeight, 1500),
        deltaMode: 0,
        bubbles: true,
        cancelable: true,
      })
    );

    const rect = best.getBoundingClientRect();
    return {
      ok: true,
      links: links.length,
      before,
      after: best.scrollTop,
      scrollHeight: best.scrollHeight,
      clientHeight: best.clientHeight,
      moved: best.scrollTop !== before,
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      candidates: candidates.length,
    };
  }, profileUsername);

  // Strategy D: real Playwright mouse wheel inside the chosen scroller.
  // This dispatches a trusted wheel event, which some IG builds require to
  // start streaming the next page.
  if (result?.ok && result.rect && result.rect.w > 0 && result.rect.h > 0) {
    try {
      const cx = result.rect.x + result.rect.w / 2;
      const cy = result.rect.y + result.rect.h - Math.min(40, result.rect.h / 4);
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, Math.max(800, result.rect.h));
    } catch {
      /* ignore */
    }
  }

  // Strategy E: keyboard. Focus the scroller and press End / PageDown.
  try {
    await page.keyboard.press('End');
  } catch {
    /* ignore */
  }

  return result;
}

/**
 * Scrape one list (followers or following) by combining two strategies:
 *   1) Intercept Instagram's internal JSON responses (stable structure).
 *   2) Scrape anchor hrefs inside the dialog as a DOM fallback.
 * The loop keeps going while the list is still growing or until it's within
 * a small margin of the expected count from the profile header.
 */
async function scrapeList({
  page,
  profileUsername,
  listType,
  idleScrollLimit,
  maxScrollIterations,
  scrollDelayMs,
  expectedCount,
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
    await openListDialog(page, profileUsername, listType);

    // Let the dialog mount and fire its first request.
    await sleep(2000);

    let idleCycles = 0;
    let lastSize = 0;
    let retryBursts = 0;
    let lastBurstSize = 0;
    const maxRetryBursts = 4;
    const target = expectedCount && expectedCount > 0 ? expectedCount : null;
    const closeEnough = target ? Math.max(target - Math.ceil(target * 0.02), target - 5) : null;

    let lastDiag = null;
    for (let i = 0; i < maxScrollIterations; i++) {
      lastDiag = await scrollDialogOnce(page, profileUsername);
      await sleep(scrollDelayMs + Math.floor(Math.random() * 600));

      if (collected.size === lastSize) {
        idleCycles += 1;

        if (idleCycles >= idleScrollLimit) {
          const reachedTarget = target ? collected.size >= closeEnough : false;

          if (target && !reachedTarget && retryBursts < maxRetryBursts) {
            // Only keep retrying if the previous retry actually grew the list.
            if (retryBursts > 0 && collected.size === lastBurstSize) {
              logger.warn('Retry burst made no progress; giving up early', {
                listType,
                collected: collected.size,
                target,
                lastDiag,
              });
              break;
            }
            retryBursts += 1;
            lastBurstSize = collected.size;
            logger.info('Under target, doing a hard scroll burst', {
              listType,
              collected: collected.size,
              target,
              attempt: retryBursts,
              maxRetryBursts,
              scroller: lastDiag,
            });
            await sleep(4000);
            for (let k = 0; k < 8; k++) {
              await scrollDialogOnce(page, profileUsername);
              await sleep(scrollDelayMs);
            }
            // Reset idleCycles so the loop gives the burst a fair chance to
            // produce new rows before re-evaluating.
            idleCycles = 0;
            continue;
          }
          logger.info('Reached end of list', {
            listType,
            size: collected.size,
            target: target ?? 'unknown',
          });
          break;
        }
      } else {
        idleCycles = 0;
        lastSize = collected.size;
        retryBursts = 0;
        if (i % 5 === 0) {
          logger.info('Scrolling...', {
            listType,
            collected: collected.size,
            target: target ?? 'unknown',
            scroller: lastDiag
              ? { rows: lastDiag.links, h: lastDiag.scrollHeight, moved: lastDiag.moved }
              : null,
          });
        }
      }
    }

    // DOM fallback: collect usernames from anchor hrefs inside the dialog.
    const domUsernames = await page.$$eval(
      'div[role="dialog"] a[role="link"]',
      (links, ownUsername) => {
        const skip = new Set([
          'explore','p','reels','stories','direct','accounts','tv',
          'challenge','legal','about','developer', ownUsername,
        ]);
        const out = [];
        for (const a of links) {
          const href = a.getAttribute('href') || '';
          const m = href.match(/^\/([^/?#]+)\/?$/);
          if (m && !skip.has(m[1])) out.push(m[1]);
        }
        return out;
      },
      profileUsername
    );
    for (const u of domUsernames) collected.add(normalizeUsername(u));

    logger.info('List scrape finished', {
      listType,
      size: collected.size,
      target: expectedCount ?? 'unknown',
      networkResponses: networkHits,
    });

    if (expectedCount && collected.size < Math.floor(expectedCount * 0.95)) {
      logger.warn(
        `Collected ${collected.size}/${expectedCount} ${listType}. ` +
          `Instagram may be throttling or virtualizing the list. ` +
          `Try rerunning, increasing IDLE_SCROLL_LIMIT, or raising SCROLL_DELAY_MS.`
      );
    }

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
  getProfileCounts,
};
