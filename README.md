# ig-unfollowers

Compare Instagram **followers** vs. **following** for your own account and
surface the usernames of people you follow who **don't follow you back**.

Defaults target `@moments_in_my`.

---

## 1) Recommended approach

**Node.js + Playwright with a persistent browser profile, driving the real
Instagram web UI while intercepting Instagram's internal JSON responses.**

Why, briefly:

1. **The public profile page is not enough.** Instagram requires an
   authenticated session to expand the followers / following modals. A public,
   unauthenticated scrape returns only the profile header (name, post count,
   counts), not the member lists. So any real solution must be authenticated.
2. **Driving the browser is the most stable option.** Instagram's private
   GraphQL / `/api/v1/friendships/...` endpoints are undocumented, require
   rotating tokens (`X-IG-App-ID`, CSRF), and regularly change. A headed
   browser driven by Playwright avoids all of that because it *is* a real
   browser session.
3. **Hybrid extraction (network + DOM) is more robust than either alone.**
   The script opens the followers/following dialog via the same click path a
   human uses, scrolls it to trigger lazy-loaded pagination, and does **two**
   things in parallel:
   - Listens to the `/api/v1/friendships/{userId}/followers/` and `.../following/`
     JSON responses Instagram fires while scrolling, and extracts `users[].username`.
   - Falls back to reading anchor hrefs inside the dialog, so anything
     rendered but not captured via network is still collected.
4. **Persistent profile = log in once.** Playwright's `launchPersistentContext`
   reuses cookies and local storage across runs, so you only log in once (and
   can handle 2FA / checkpoints manually the first time).

This is deliberately **not** a headless mass-scraper. It runs one logged-in
session against your own account, with waits and jitter, exactly like a user
would.

### Limitations you should know up front

- Instagram actively throttles/soft-blocks sessions that hit follower lists
  too frequently. The script throttles scrolls; still, don't run it every few
  minutes.
- Very large accounts (hundreds of thousands of followers) will take a long
  time and are more likely to be throttled. Instagram also caps how much of
  a list is reachable in a single session.
- Usernames can change. The "not following back" list is a snapshot in time.
- Selectors may still drift. The script prefers **role/href-based** locators,
  detects the scroll container dynamically, and uses **network interception**
  as the primary data source — so UI class-name changes alone don't break it.

---

## 2) The script

See:

- [`src/index.js`](src/index.js) – entry point, config, diff, output.
- [`src/scrape.js`](src/scrape.js) – login, dialog opening, scroll loop,
  network + DOM extraction.
- [`src/logger.js`](src/logger.js) – timestamped logging.

---

## 3) Setup instructions

### Dependencies

Requires **Node.js 18+**.

```bash
npm install
# The postinstall step runs `playwright install chromium`.
# If it didn't, run it manually:
npx playwright install chromium
```

On Linux you may additionally need system libs:

```bash
npx playwright install-deps chromium
```

### Configure

```bash
cp .env.example .env
# edit .env as needed
```

Key variables (all optional, sensible defaults):

| Variable                | Default              | What it does                                            |
| ----------------------- | -------------------- | ------------------------------------------------------- |
| `IG_PROFILE`            | `moments_in_my`      | Handle to analyze (must be your own account).           |
| `IG_USERNAME`           | *(empty)*            | Optional — enables automated login.                     |
| `IG_PASSWORD`           | *(empty)*            | Optional — enables automated login.                     |
| `HEADLESS`              | `false`              | Keep `false` for first run / 2FA.                       |
| `USER_DATA_DIR`         | `./.browser-data`    | Persistent browser profile (keeps you logged in).       |
| `OUT_DIR`               | `./output`           | Where reports are written.                              |
| `IDLE_SCROLL_LIMIT`     | `8`                  | Scroll cycles with no new users before stopping.        |
| `MAX_SCROLL_ITERATIONS` | `4000`               | Safety upper bound on scroll iterations per list.       |
| `SCROLL_DELAY_MS`       | `1400`               | Base delay between scrolls (small random jitter added). |

### Authenticate (once) — no credentials in config

**You never need to put your Instagram password in `.env`, the repo, or
anywhere else on disk.** The recommended flow uses an interactive login,
exactly like logging into Instagram in Chrome:

```bash
npm run login
```

1. A Chromium window opens at instagram.com.
2. Log in manually — username, password, 2FA, any checkpoints. The script
   doesn't see what you type.
3. Once the nav rail appears, the script detects you're logged in, saves the
   resulting **session cookie** to `./.browser-data/`, and exits.
4. Every later `npm start` reuses that cookie. Your password is not stored
   and not seen by the script.

This is the same security model as staying logged in to Instagram in a
regular browser: a session cookie in a local profile folder. The
`.browser-data/` directory is gitignored so it cannot be accidentally
committed — still, treat it like you'd treat your browser profile, and don't
share it.

<details>
<summary>Alternative (not recommended): credentials in <code>.env</code></summary>

For unattended / headless setups only, you can set `IG_USERNAME` and
`IG_PASSWORD` in `.env` and the script will attempt an automated login. For
personal use on your own account, use `npm run login` instead — storing your
Instagram password in a file is unnecessary risk.

</details>

### Run

```bash
npm start
```

First open will be slow (page loads, session hydrates). Keep the window
visible so Instagram is less likely to flag the session.

---

## 4) Output behavior

Console summary:

```
===== Instagram unfollower report =====
Profile:                     @moments_in_my
Total followers collected:   1234
Total following collected:   567
Not following you back:      89
You don't follow them back:  756
=======================================

First up to 20 not-following-back:
  - alice
  - bob
  ...
```

Files written to `./output/` (timestamped so you can diff between runs):

- `not_following_back_<ts>.txt` – the requested list, one username per line.
- `not_following_back_<ts>.csv` – same list with profile URLs.
- `followers_<ts>.txt` – full collected followers list.
- `following_<ts>.txt` – full collected following list.
- `fans_not_followed_back_<ts>.txt` – the reverse set (fans you don't follow).

All usernames are normalized (lowercased, no `@`, trimmed) and deduplicated
via a `Set`, so comparison is case-consistent.

---

## 5) Reliability considerations

### Instagram rate limits / lazy loading

- The script doesn't hammer any endpoint; it only scrolls the real dialog
  and consumes the responses Instagram itself fires.
- `SCROLL_DELAY_MS` is the base delay between scroll events, with a small
  random jitter so the cadence isn't perfectly uniform.
- Scrolling stops automatically once `IDLE_SCROLL_LIMIT` consecutive cycles
  produce no new users — this avoids pointless spinning at the end of a list.
- If you run this on a large account, expect long runtimes. If you see IG
  insert a "Try again later" interstitial, stop, wait a few hours, and retry.

### Recovering from partial failures

- The session is persistent, so a crash mid-run doesn't force a re-login.
- Followers and following are each written to their own timestamped files
  after the run. If the process dies after collecting followers but before
  following, rerun — the persistent session means there's no relogin cost,
  and the diff only runs when both lists are complete.
- Network interception and DOM scraping are additive into the same `Set`,
  so even if one mechanism misses entries the other often catches them.
- Every major step logs with a timestamp and metadata. Set `DEBUG=1` to see
  debug-level messages (e.g., unparseable responses).

### Handling Instagram UI changes

The code is intentionally resilient to most UI drift because it:

- Uses **role-based** locators (`div[role="dialog"]`, `a[role="link"]`) and
  **href-based** locators (`a[href$="/followers/"]`), not class names.
- **Detects the scroll container dynamically** by scanning the dialog for
  the first scrollable descendant, instead of hardcoding a class.
- **Prefers network data** (`/api/v1/friendships/{id}/followers/`,
  `.../following/`) over DOM — IG can reshape the DOM without changing the
  JSON shape.

If Instagram does change something:

1. **DOM-only breakage:** run with `DEBUG=1 npm start` and check the logs.
   If the dialog never appears, update the click selectors in
   `openListDialog()` (top of `src/scrape.js`).
2. **Network shape change:** if `networkResponses` stays at 0 in the final
   log line, Instagram changed the endpoint path. Update the regex in
   `onResponse()` inside `scrapeList()` (currently
   `/\/friendships\/\d+\/(followers|following)\//`).
3. **Scroll no longer paginates:** some IG builds only paginate on wheel
   events — the script already emits wheel events in addition to setting
   `scrollTop`. If both stop working, try moving the cursor inside the
   dialog with `page.mouse.move(...)` before the wheel call.
4. **Login page redesign:** manual login (`npm run login`) sidesteps this
   entirely — you just log in as a human, and the saved session is reused.

---

## Notes

- Only use this on accounts you own or are authorized to analyze.
- Don't commit `.env`, `.browser-data/`, or `output/` — they're gitignored.
