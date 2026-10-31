import axios from "axios";
import { createHash } from "node:crypto";
import type { Browser, BrowserContext, Page } from "playwright";

const LOGIN_URL =
  "https://account.formula1.com/#/es/login?redirect=https%3A%2F%2Ff1tv.formula1.com%2F";
const SIGNALR_NEGOTIATE_URL =
  "https://livetiming.formula1.com/signalrcore/negotiate?negotiateVersion=1";
const TOKEN_KEY_PATTERN = /token|auth|login|subscription/i;
const JWT_PATTERN = /^[\w-]+\.[\w-]+\.[\w-]+$/;

interface StoredValue {
  key: string;
  value: string;
}

export interface F1TvSubscriptionToken {
  token: string;
  source: string;
}

function getTokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

function addTokenCandidates(
  value: unknown,
  keyHint: string,
  candidates: Set<string>,
  depth = 0,
): void {
  if (depth > 8) return;

  if (typeof value === "string") {
    const candidate = value.replace(/^Bearer\s+/i, "").trim();
    const looksLikeToken =
      JWT_PATTERN.test(candidate) ||
      (TOKEN_KEY_PATTERN.test(keyHint) &&
        candidate.length >= 24 &&
        candidate.length <= 8192 &&
        /^[A-Za-z0-9._~+/-]+={0,2}$/.test(candidate));

    if (looksLikeToken) candidates.add(candidate);

    if (candidate.startsWith("{") || candidate.startsWith("[")) {
      try {
        addTokenCandidates(JSON.parse(candidate), keyHint, candidates, depth + 1);
      } catch {
        // Storage values are not necessarily JSON.
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) =>
      addTokenCandidates(item, keyHint, candidates, depth + 1),
    );
    return;
  }

  if (value && typeof value === "object") {
    for (const [key, nestedValue] of Object.entries(value)) {
      addTokenCandidates(nestedValue, key, candidates, depth + 1);
    }
  }
}

function addLoginSessionToken(
  cookieValue: string,
  candidates: Set<string>,
): void {
  const valuesToParse = new Set([cookieValue]);
  try {
    valuesToParse.add(decodeURIComponent(cookieValue));
  } catch {
    // The cookie may already contain raw JSON rather than URL-encoded JSON.
  }

  for (const value of valuesToParse) {
    try {
      const session = JSON.parse(value) as {
        data?: { subscriptionToken?: unknown };
      };
      if (typeof session.data?.subscriptionToken === "string") {
        addTokenCandidates(
          session.data.subscriptionToken,
          "subscriptionToken",
          candidates,
        );
      }
    } catch {
      // Ignore cookie values that are not the login-session JSON payload.
    }
  }
}

async function getStoredValues(
  page: import("playwright").Page,
): Promise<StoredValue[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (page.isClosed()) return [];

    try {
      return await page.evaluate(() => {
        const values: StoredValue[] = [];
        for (const storage of [localStorage, sessionStorage]) {
          for (let index = 0; index < storage.length; index++) {
            const key = storage.key(index);
            if (key !== null) {
              const value = storage.getItem(key);
              if (value !== null) values.push({ key, value });
            }
          }
        }
        return values;
      });
    } catch (error) {
      const isNavigationRace =
        error instanceof Error &&
        /execution context was destroyed|most likely because of a navigation/i.test(
          error.message,
        );
      if (!isNavigationRace) throw error;
      if (attempt < 2 && !page.isClosed()) await page.waitForTimeout(200);
    }
  }

  return [];
}

async function isSubscriptionToken(token: string): Promise<boolean> {
  const response = await axios.post(SIGNALR_NEGOTIATE_URL, null, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "BestHTTP",
      Accept: "application/json",
    },
    timeout: 10000,
    validateStatus: () => true,
  });

  console.log(
    `[F1 Auth] SignalR negotiate returned HTTP ${response.status} for fingerprint=${getTokenFingerprint(token)}.`,
  );
  if (response.status === 401 || response.status === 403) return false;
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `F1 SignalR token validation returned HTTP ${response.status}.`,
    );
  }

  return Boolean(response.data?.connectionId || response.data?.connectionToken);
}

export async function getF1TvSubscriptionToken(options: {
  email?: string;
  password?: string;
  executablePath?: string;
  headless?: boolean;
}): Promise<F1TvSubscriptionToken> {
  const { chromium } = await import("playwright");
  const browser: Browser = await chromium.launch({
    headless: options.headless ?? true,
    ...(options.executablePath
      ? { executablePath: options.executablePath }
      : {}),
  });
  const context: BrowserContext = await browser.newContext();
  let page: Page | null = null;

  try {
    const candidates = new Map<string, Set<string>>();
    const checkedCandidates = new Set<string>();
    const reportedUntrustedCandidates = new Set<string>();
    let lastLoginCookieState: boolean | null = null;

    const collectCandidates = (
      value: unknown,
      keyHint: string,
      source: string,
      depth = 0,
    ): void => {
      if (depth > 8) return;

      if (typeof value === "string") {
        const candidate = value.replace(/^Bearer\s+/i, "").trim();
        const looksLikeToken =
          JWT_PATTERN.test(candidate) ||
          (TOKEN_KEY_PATTERN.test(keyHint) &&
            candidate.length >= 24 &&
            candidate.length <= 8192 &&
            /^[A-Za-z0-9._~+/-]+={0,2}$/.test(candidate));

        if (looksLikeToken) {
          const sources = candidates.get(candidate) ?? new Set<string>();
          sources.add(`${source}:key=${keyHint}`);
          candidates.set(candidate, sources);
        }

        if (candidate.startsWith("{") || candidate.startsWith("[")) {
          try {
            collectCandidates(
              JSON.parse(candidate),
              keyHint,
              source,
              depth + 1,
            );
          } catch {
            // Storage and response strings are not necessarily JSON.
          }
        }
        return;
      }

      if (Array.isArray(value)) {
        value.forEach((item) =>
          collectCandidates(item, keyHint, source, depth + 1),
        );
        return;
      }

      if (value && typeof value === "object") {
        for (const [key, nestedValue] of Object.entries(value)) {
          collectCandidates(nestedValue, key, source, depth + 1);
        }
      }
    };

    const findValidCandidate = async (): Promise<string | null> => {
      const cookies = await context.cookies();
      const hasLoginSession = cookies.some(
        (cookie) =>
          cookie.name === "login-session" &&
          cookie.domain.endsWith("formula1.com"),
      );
      if (hasLoginSession !== lastLoginCookieState) {
        console.log(
          `[F1 Auth] Browser login-session cookie present=${hasLoginSession}.`,
        );
        lastLoginCookieState = hasLoginSession;
      }

      for (const cookie of cookies) {
        if (!cookie.domain.endsWith("formula1.com")) continue;
        const found = new Set<string>();
        if (cookie.name === "login-session") {
          addLoginSessionToken(cookie.value, found);
        } else {
          addTokenCandidates(cookie.value, cookie.name, found);
        }
        for (const candidate of found) {
          const sources = candidates.get(candidate) ?? new Set<string>();
          sources.add(
            cookie.name === "login-session"
              ? "cookie:login-session:data.subscriptionToken"
              : `cookie:${cookie.name}`,
          );
          candidates.set(candidate, sources);
        }
      }

      for (const [token, sources] of candidates) {
        if (checkedCandidates.has(token)) continue;
        const fingerprint = getTokenFingerprint(token);
        const trustedSources = [...sources].filter(
          (source) =>
            source === "cookie:login-session:data.subscriptionToken" ||
            /(?:^|[.:])subscriptionToken$/i.test(
              source.slice(source.lastIndexOf(":key=") + 5),
            ) ||
            source.startsWith("request:"),
        );
        if (trustedSources.length === 0) {
          if (!reportedUntrustedCandidates.has(token)) {
            console.log(
              `[F1 Auth] Ignoring unverified token candidate fingerprint=${fingerprint} source=${[...sources].join(",")}.`,
            );
            reportedUntrustedCandidates.add(token);
          }
          continue;
        }
        checkedCandidates.add(token);
        console.log(
          `[F1 Auth] Validating token candidate fingerprint=${fingerprint} length=${token.length} source=${trustedSources.join(",")}`,
        );
        const valid = await isSubscriptionToken(token);
        console.log(
          `[F1 Auth] Token candidate fingerprint=${fingerprint} validation=${valid ? "accepted" : "rejected"}`,
        );
        if (valid) return token;
      }
      return null;
    };

    context.on("request", (request) => {
      const requestUrl = new URL(request.url());
      if (requestUrl.hostname !== "livetiming.formula1.com") return;

      const authorization = request.headers()["authorization"];
      if (authorization) {
        collectCandidates(
          authorization,
          "authorization",
          "request:authorization",
        );
      }
      const queryToken = requestUrl.searchParams.get("access_token");
      if (queryToken) {
        collectCandidates(
          queryToken,
          "access_token",
          "request:access_token",
        );
      }
    });

    context.on("response", (response) => {
      const responseUrl = new URL(response.url());
      const contentType = response.headers()["content-type"] || "";
      if (
        !responseUrl.hostname.endsWith("formula1.com") ||
        responseUrl.hostname === "consent.formula1.com" ||
        (response.status() >= 300 && response.status() < 400) ||
        !contentType.includes("application/json")
      ) {
        return;
      }

      void response
        .json()
        .then((body: unknown) =>
          collectCandidates(
            body,
            responseUrl.pathname,
            `response:${responseUrl.pathname}`,
          ),
        )
        .catch((error: unknown) => {
          if (
            error instanceof Error &&
            /no resource with given identifier|response body is unavailable|target page, context or browser has been closed/i.test(
              error.message,
            )
          ) {
            return;
          }
          console.warn(
            `[F1] Could not inspect an authentication response from ${responseUrl.hostname}:`,
            error,
          );
        });
    });

    const existingSessionToken = await findValidCandidate();
    if (existingSessionToken) {
      return {
        token: existingSessionToken,
        source: [...(candidates.get(existingSessionToken) ?? [])].join(","),
      };
    }

    if (!options.email || !options.password) {
      throw new Error(
        "No valid Live Timing token was found in the connected Chrome session. " +
          "Sign in to F1 TV in that profile or configure F1TV_EMAIL and F1TV_PASSWORD.",
      );
    }

    page = await context.newPage();
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

    const consentButton = page
      .frameLocator('iframe[title*="Consent"]')
      .getByRole("button", { name: "Accept all", exact: true });
    try {
      await consentButton.waitFor({ state: "visible", timeout: 5000 });
      await consentButton.click();
      console.log("[F1] Accepted all cookies.");
    } catch (error) {
      if (!(error instanceof Error) || !/Timeout/i.test(error.name)) {
        throw error;
      }
      console.log("[F1] Cookie consent not shown; continuing to login.");
    }

    const emailInput = page.locator(
      'input[name="username"], input[type="email"]',
    ).first();
    const passwordInput = page
      .locator('input[name="password"], input[type="password"]')
      .first();
    await emailInput.waitFor({ state: "visible", timeout: 30000 });
    await emailInput.fill(options.email);
    await passwordInput.waitFor({ state: "visible", timeout: 10000 });
    await passwordInput.fill(options.password);

    const submitButton = page
      .getByRole("button", { name: /iniciar sesi[oó]n|sign in|log in/i })
      .last();
    if (await submitButton.count()) {
      await submitButton.click();
    } else {
      await passwordInput.press("Enter");
    }

    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      for (const browserPage of context.pages()) {
        if (
          browserPage.isClosed() ||
          !/^https?:/.test(browserPage.url())
        ) {
          continue;
        }

        for (const stored of await getStoredValues(browserPage)) {
          collectCandidates(
            stored.value,
            stored.key,
            `browser-storage:${stored.key}`,
          );
        }
      }

      const validToken = await findValidCandidate();
      if (validToken) {
        return {
          token: validToken,
          source: [...(candidates.get(validToken) ?? [])].join(","),
        };
      }

      await page.waitForTimeout(1000);
    }

    throw new Error(
      "F1 TV login completed without a valid Live Timing subscription token. " +
        "The login may require CAPTCHA/MFA, or Formula 1 may have changed its authentication flow.",
    );
  } finally {
    if (page && !page.isClosed()) await page.close();
    await context.close();
    await browser.close();
  }
}
