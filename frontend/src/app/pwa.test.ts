import { describe, expect, it } from 'vitest';
import { manualInstallFor } from './pwa';

/**
 * Which platform gets told how to install Piggy by hand.
 *
 * Worth a test rather than an eye, because every branch is one user-agent
 * string away from the next, nothing about a wrong answer shows up in the
 * browser you happen to be testing in, and a wrong answer sends somebody
 * hunting for a menu entry their phone does not have. The costly direction is
 * silence: an install offer hung entirely off `beforeinstallprompt` — the event
 * only Chromium fires — tells every iPhone that Piggy cannot be installed,
 * which on iOS is also the difference between a book that survives a week of
 * not being opened and one Safari clears.
 */

const CHROME_DESKTOP =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
const FIREFOX_ANDROID = 'Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0';
const FIREFOX_DESKTOP = 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const CHROME_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1';
const FIREFOX_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15';
const SAFARI_IPADOS =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

describe('manualInstallFor', () => {
  it('stays quiet where the browser fires its own install prompt', () => {
    expect(manualInstallFor(CHROME_DESKTOP, 'Linux x86_64', 0)).toBeNull();
    expect(manualInstallFor(CHROME_ANDROID, 'Linux armv8l', 5)).toBeNull();
  });

  it('sends every iOS browser to the share sheet, not Safari alone', () => {
    expect(manualInstallFor(SAFARI_IPHONE, 'iPhone', 5)).toBe('ios');
    // Chrome and Firefox on iOS are WebKit, and install exactly the web app
    // Safari does — Add to Home Screen has been theirs since iOS 16.4.
    expect(manualInstallFor(CHROME_IPHONE, 'iPhone', 5)).toBe('ios');
    expect(manualInstallFor(FIREFOX_IPHONE, 'iPhone', 5)).toBe('ios');
  });

  it('sees through an iPad claiming to be a Mac', () => {
    expect(manualInstallFor(SAFARI_IPADOS, 'MacIntel', 5)).toBe('ios');
    // A real Mac reports the same platform with no touch, and installs through
    // Chrome's own prompt or not at all.
    expect(manualInstallFor(SAFARI_IPADOS, 'MacIntel', 0)).toBeNull();
  });

  it('tells Firefox on Android about its own menu', () => {
    expect(manualInstallFor(FIREFOX_ANDROID, 'Linux armv8l', 5)).toBe('firefox');
  });

  it('stays quiet on desktop Firefox, which cannot install a web app at all', () => {
    // Directions to a menu entry that does not exist are worse than nothing.
    expect(manualInstallFor(FIREFOX_DESKTOP, 'Linux x86_64', 0)).toBeNull();
  });
});
