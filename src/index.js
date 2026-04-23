#!/usr/bin/env node
'use strict';

require('dotenv').config();
const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');

const logger = require('./logger');
const { ensureLoggedIn, scrapeList } = require('./scrape');

const CONFIG = {
  profile: (process.env.IG_PROFILE || 'moments_in_my').replace(/^@+/, '').toLowerCase(),
  username: process.env.IG_USERNAME || '',
  password: process.env.IG_PASSWORD || '',
  headless: String(process.env.HEADLESS || 'false').toLowerCase() === 'true',
  userDataDir: path.resolve(process.env.USER_DATA_DIR || './.browser-data'),
  outDir: path.resolve(process.env.OUT_DIR || './output'),
  idleScrollLimit: parseInt(process.env.IDLE_SCROLL_LIMIT || '8', 10),
  maxScrollIterations: parseInt(process.env.MAX_SCROLL_ITERATIONS || '4000', 10),
  scrollDelayMs: parseInt(process.env.SCROLL_DELAY_MS || '1400', 10),
};

const ARGS = new Set(process.argv.slice(2));
const LOGIN_ONLY = ARGS.has('--login-only');

async function writeList(file, items) {
  await fs.writeFile(file, items.join('\n') + (items.length ? '\n' : ''), 'utf8');
}

async function writeCsv(file, header, rows) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.map(esc).join(',')];
  for (const row of rows) lines.push(row.map(esc).join(','));
  await fs.writeFile(file, lines.join('\n') + '\n', 'utf8');
}

async function main() {
  await fs.mkdir(CONFIG.outDir, { recursive: true });
  await fs.mkdir(CONFIG.userDataDir, { recursive: true });

  logger.info('Launching browser', {
    headless: CONFIG.headless,
    userDataDir: CONFIG.userDataDir,
    profile: CONFIG.profile,
  });

  const context = await chromium.launchPersistentContext(CONFIG.userDataDir, {
    headless: CONFIG.headless,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  const page = context.pages()[0] || (await context.newPage());

  try {
    await ensureLoggedIn(page, {
      username: CONFIG.username,
      password: CONFIG.password,
    });

    if (LOGIN_ONLY) {
      logger.info('Login-only run complete. Session stored in userDataDir; exiting.');
      return;
    }

    const followers = await scrapeList({
      page,
      profileUsername: CONFIG.profile,
      listType: 'followers',
      idleScrollLimit: CONFIG.idleScrollLimit,
      maxScrollIterations: CONFIG.maxScrollIterations,
      scrollDelayMs: CONFIG.scrollDelayMs,
    });

    const following = await scrapeList({
      page,
      profileUsername: CONFIG.profile,
      listType: 'following',
      idleScrollLimit: CONFIG.idleScrollLimit,
      maxScrollIterations: CONFIG.maxScrollIterations,
      scrollDelayMs: CONFIG.scrollDelayMs,
    });

    const notFollowingBack = [...following].filter((u) => !followers.has(u)).sort();
    const fansNotFollowedBack = [...followers].filter((u) => !following.has(u)).sort();

    console.log('\n===== Instagram unfollower report =====');
    console.log(`Profile:                     @${CONFIG.profile}`);
    console.log(`Total followers collected:   ${followers.size}`);
    console.log(`Total following collected:   ${following.size}`);
    console.log(`Not following you back:      ${notFollowingBack.length}`);
    console.log(`You don't follow them back:  ${fansNotFollowedBack.length}`);
    console.log('=======================================\n');

    if (notFollowingBack.length) {
      const preview = notFollowingBack.slice(0, 20);
      console.log('First up to 20 not-following-back:');
      for (const u of preview) console.log(`  - ${u}`);
      if (notFollowingBack.length > preview.length) {
        console.log(`  ...and ${notFollowingBack.length - preview.length} more`);
      }
      console.log('');
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputs = {
      notFollowingBackTxt: path.join(CONFIG.outDir, `not_following_back_${stamp}.txt`),
      notFollowingBackCsv: path.join(CONFIG.outDir, `not_following_back_${stamp}.csv`),
      followersTxt: path.join(CONFIG.outDir, `followers_${stamp}.txt`),
      followingTxt: path.join(CONFIG.outDir, `following_${stamp}.txt`),
      fansTxt: path.join(CONFIG.outDir, `fans_not_followed_back_${stamp}.txt`),
    };

    await writeList(outputs.notFollowingBackTxt, notFollowingBack);
    await writeCsv(
      outputs.notFollowingBackCsv,
      ['username', 'profile_url'],
      notFollowingBack.map((u) => [u, `https://www.instagram.com/${u}/`])
    );
    await writeList(outputs.followersTxt, [...followers].sort());
    await writeList(outputs.followingTxt, [...following].sort());
    await writeList(outputs.fansTxt, fansNotFollowedBack);

    logger.info('Report written', outputs);
  } catch (err) {
    logger.error('Run failed', { error: err.message, stack: err.stack });
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
  }
}

main();
