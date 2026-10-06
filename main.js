/**
* agentic-cx v1.6.4
* https://github.com/weni-ai/agentic-cx
**/

if (!window.agenticCXScriptAlreadyInserted) {
  window.agenticCXScriptAlreadyInserted = true;

  const timeToCallNextAbandonedCartUpdateInSeconds = 15 * 60; // 15 minutes
  const ACCOUNT_WATCH_TIMEOUT_MS = 30 * 1e3;
  const ACCOUNT_WATCH_INTERVAL_MS = 5 * 1e3;
  const IDLE_CALLBACK_TIMEOUT_MS = 2 * 1e3;
  const IDLE_FALLBACK_BUDGET_MS = 8;
  const WEBCHAT_FAST_CHECK_INTERVAL_MS = 1e3;
  const WEBCHAT_FAST_CHECK_ATTEMPTS = 60;
  const WEBCHAT_SLOW_CHECK_INTERVAL_MS = 5 * 1e3;
  const SESSION_TOKEN_POLL_INTERVAL_MS = 60 * 1e3;
  const FAST_STORE_STARTER_ACCOUNT = 'storeframework';
  const FAST_STORE_STORE_ID_PATTERN = /api:\{storeId:"([a-z0-9-]+)"/g;
  const VTEX_ASSETS_ACCOUNT_PATTERN = /^https?:\/\/([a-z0-9-]+)\.vtexassets\.com\/?$/i;

  let notifyAbandonedCartTimeout;
  let detailsRequest = null;
  let cachedSessionAccount;
  let cachedFastStoreAccount;
  let webpackRequire;
  let fastStoreProbeInstalled = false;
  let webChatReadyPromise = null;
  const seenFastStoreModuleIds = new Set();
  const foundFastStoreAccountIds = new Set();
  const attemptedWebChatAccounts = new Set();

  function log(...messages) {
    try {
      if (localStorage.getItem('showWeniPixelLogs') === 'true') {
        console.log(`[Gist Pixel Script - ${new Date().toISOString()}] ${messages.join(' ')}`);
      }
    } catch {
      // localStorage access can throw in restricted contexts (Safari ITP,
      // third-party iframes with cookies blocked). Logging is best-effort.
    }
  }

  function startSafely(label, start) {
    try {
      Promise.resolve(start()).catch((error) => log(`${label} failed:`, error?.message || error));
    } catch (error) {
      log(`${label} failed:`, error?.message || error);
    }
  }

  const throttle = (func, limit) => {
    let inThrottle;

    return function (...args) {
      const context = this;

      if (!inThrottle) {
        func.apply(context, args);
        inThrottle = true;

        setTimeout(() => {
          inThrottle = false;
        }, limit);
      }
    };
  };

  JSON.safeStringify = (obj, indent = 2) => {
    let cache = [];
    const retVal = JSON.stringify(
      obj,
      (key, value) =>
        typeof value === "object" && value !== null
          ? cache.includes(value)
            ? undefined
            : cache.push(value) && value
          : value,
      indent
    );
    cache = null;
    return retVal;
  };

  function getDetails() {
    if (!detailsRequest) {
      detailsRequest = fetch('/api/sessions?items=*')
        .then((response) => response.json())
        .then((data) => {
          log('got user data:', JSON.safeStringify(data.namespaces?.profile, 2));
          const account = data.namespaces?.account;
          if (account) cachedSessionAccount = account;
          return {
            profile: data.namespaces?.profile,
            account,
          };
        })
        .finally(() => {
          detailsRequest = null;
        });
    }

    return detailsRequest;
  }

  function getAccountSession() {
    if (cachedSessionAccount) return Promise.resolve(cachedSessionAccount);
    return getDetails().then(({ account }) => account);
  }

  async function getSessionAccountSafely() {
    try {
      return await getAccountSession();
    } catch (error) {
      log('sessions account lookup failed:', error?.message || error);
      return undefined;
    }
  }

  function sessionAccountId(account) {
    const rawAccountId = account?.id?.value;
    return typeof rawAccountId === 'string' ? rawAccountId.replace(/-/g, '') : rawAccountId;
  }

  async function getProfileFromGraphQL() {
    try {
      const response = await fetch('/_v/private/graphql/v1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: `query {
            profile {
              firstName
              phone
              homePhone
              businessPhone
            }
          }`,
        }),
      });
      const result = await response.json();
      return result?.data?.profile || null;
    } catch (error) {
      log('getProfileFromGraphQL failed:', error?.message || error);
      return null;
    }
  }

  function notifyAbandonedCart() {
    log('calling notifyAbandonedCart function');

    clearTimeout(notifyAbandonedCartTimeout);

    fetch('/api/checkout/pub/orderForm')
      .then((response) => response.json())
      .then(async (data) => {
        notifyAbandonedCartTimeout = setTimeout(
          notifyAbandonedCart,
          timeToCallNextAbandonedCartUpdateInSeconds * 1e3
        );

        const cart_id = data?.orderFormId;
        let phone = data?.clientProfileData?.phone;
        let name = data?.clientProfileData?.firstName;
        let accountName = readPageAccount();

        if (!phone || !name) {
          const gqlProfile = await getProfileFromGraphQL();

          if (!phone) {
            phone = gqlProfile?.homePhone || gqlProfile?.businessPhone || gqlProfile?.phone;
          }

          if (!name) {
            name = gqlProfile?.firstName;
          }
        }

        if (!phone || !name || !accountName) {
          const { profile, account } = await getDetails().catch((error) => {
            log('notifyAbandonedCart: sessions lookup failed:', error?.message || error);
            return {};
          });

          if (!phone) {
            phone = profile?.phone?.value;
          }

          if (!name) {
            name = profile?.firstName?.value || profile?.lastName?.value;
          }

          if (!accountName) {
            accountName = account?.accountName?.value;
          }
        }

        if (!accountName) {
          accountName = await guessVtexAccount();
        }

        if (!accountName) {
          log('notifyAbandonedCart: missing accountName, skipping abandoned cart notification');
          return;
        }

        if (!cart_id || !phone || !name) {
          log('notifyAbandonedCart: missing cart_id, phone or name, skipping abandoned cart notification');
          return;
        }

        const headers = {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        };

        const body = JSON.stringify({
          cart_id,
          phone,
          account: accountName,
          name,
        });

        const requestOptions = {
          method: 'POST',
          headers,
          body,
        };

        fetch('/_v/abandoned-cart-notification', requestOptions)
          .then((response) => { if (response.status !== 200) { throw new Error('Status different from 200') } })
          .catch(() => {
            fetch(`https://${accountName}.myvtex.com/_v/abandoned-cart-notification`, requestOptions)
              .catch((error) => log('abandoned-cart fallback failed:', error?.message || error));
          });
      })
      .catch((error) => log('notifyAbandonedCart failed:', error?.message || error));
  }

  function handleEvents(e) {
    const eventName = e.data?.eventName;
    switch (eventName) {
      case 'vtex:addToCart': {
        notifyAbandonedCart();
        return;
      }
    }
  }

  function listenToJQueryOrderFormUpdates() {
    if (typeof $ !== 'function') return;

    const $win = $(window);
    if ($win && typeof $win.on === 'function') {
      const notifyAbandonedCartThrottled = throttle(notifyAbandonedCart, 3e3);
      $win.on('orderFormUpdated.vtex', notifyAbandonedCartThrottled);
    }
  }

  function runWhenIdle(callback) {
    try {
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(callback, { timeout: IDLE_CALLBACK_TIMEOUT_MS });
        return;
      }
    } catch {
      // Fall back to a short timer slice below.
    }

    setTimeout(() => {
      const budgetEndsAt = Date.now() + IDLE_FALLBACK_BUDGET_MS;
      callback({ timeRemaining: () => Math.max(0, budgetEndsAt - Date.now()) });
    }, 0);
  }

  function readAccountSource(read) {
    try {
      return read() || undefined;
    } catch {
      return undefined;
    }
  }

  function readPageAccount() {
    return (
      readAccountSource(() => window.__RUNTIME__?.account) ||
      readAccountSource(() => window.VTEX_METADATA?.account)
    );
  }

  function readAccountFromAssetLinks() {
    try {
      const accounts = new Set();
      const links = document.querySelectorAll('link[rel="preconnect"], link[rel="dns-prefetch"]');

      for (const link of links) {
        try {
          const href = link.getAttribute('href') || '';
          const match = String(href).match(VTEX_ASSETS_ACCOUNT_PATTERN);
          if (match) accounts.add(match[1].toLowerCase());
        } catch {
          continue;
        }
      }

      if (accounts.size !== 1) return undefined;
      return [...accounts][0];
    } catch {
      return undefined;
    }
  }

  function ensureWebpackRequire() {
    if (webpackRequire) return webpackRequire;

    const chunks = window.webpackChunk_N_E;
    if (!chunks || typeof chunks.push !== 'function' || fastStoreProbeInstalled) {
      return webpackRequire;
    }

    fastStoreProbeInstalled = true;
    try {
      chunks.push([
        ['weni-vtex-account'],
        {},
        (require) => {
          webpackRequire = require;
        },
      ]);
    } catch {
      fastStoreProbeInstalled = false;
    }

    return webpackRequire;
  }

  function collectStoreIds(source) {
    FAST_STORE_STORE_ID_PATTERN.lastIndex = 0;
    let match = FAST_STORE_STORE_ID_PATTERN.exec(source);
    while (match) {
      foundFastStoreAccountIds.add(match[1]);
      match = FAST_STORE_STORE_ID_PATTERN.exec(source);
    }
  }

  function scanFastStoreModule(modules, id) {
    if (seenFastStoreModuleIds.has(id)) return;
    seenFastStoreModuleIds.add(id);

    try {
      collectStoreIds(Function.prototype.toString.call(modules[id]));
    } catch {
      // Skip modules whose source cannot be read.
    }
  }

  function scanFastStoreModulesWhenIdle() {
    return new Promise((resolve) => {
      let pendingModuleIds;

      const scanSlice = (deadline) => {
        try {
          const modules = ensureWebpackRequire()?.m;
          if (!modules) {
            resolve();
            return;
          }

          if (!pendingModuleIds) {
            pendingModuleIds = Object.keys(modules).filter((id) => !seenFastStoreModuleIds.has(id));
          }

          let scannedInSlice = 0;
          while (pendingModuleIds.length && (scannedInSlice === 0 || deadline.timeRemaining() > 1)) {
            scanFastStoreModule(modules, pendingModuleIds.pop());
            scannedInSlice++;
          }

          if (pendingModuleIds.length) {
            runWhenIdle(scanSlice);
            return;
          }
        } catch {
          // An unreadable webpack runtime means no FastStore account.
        }

        resolve();
      };

      runWhenIdle(scanSlice);
    });
  }

  function readFastStoreAccount() {
    if (cachedFastStoreAccount) return cachedFastStoreAccount;

    const candidates = [...foundFastStoreAccountIds].filter(
      (account) => account !== FAST_STORE_STARTER_ACCOUNT,
    );
    if (candidates.length !== 1) return undefined;

    cachedFastStoreAccount = candidates[0];
    return cachedFastStoreAccount;
  }

  async function guessVtexAccount() {
    const assetLinksAccount = readAccountSource(readAccountFromAssetLinks);
    if (assetLinksAccount) return assetLinksAccount;

    if (!cachedFastStoreAccount) await scanFastStoreModulesWhenIdle();
    return readAccountSource(readFastStoreAccount);
  }

  async function resolveVtexAccountName() {
    const pageAccount = readPageAccount();
    if (pageAccount) return pageAccount;

    const sessionAccount = await getSessionAccountSafely();
    return sessionAccount?.accountName?.value || guessVtexAccount();
  }

  function watchVtexAccount(onAccount) {
    const deadline = Date.now() + ACCOUNT_WATCH_TIMEOUT_MS;

    const tick = async () => {
      try {
        const account = readPageAccount() || (await guessVtexAccount());
        if (account && (await onAccount(account))) return;
      } catch (error) {
        log('watchVtexAccount tick failed:', error?.message || error);
      }

      if (Date.now() + ACCOUNT_WATCH_INTERVAL_MS > deadline) return;
      setTimeout(tick, ACCOUNT_WATCH_INTERVAL_MS);
    };

    setTimeout(tick, ACCOUNT_WATCH_INTERVAL_MS);
  }

  function tryToRenderWebChat(account) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.addEventListener('load', resolve);
      script.addEventListener('error', reject);
      script.src = `https://cdn.cloud.weni.ai/VTEXApp/accounts/${account}/webchat.js`;
      document.head.appendChild(script);
    });
  }

  async function tryWebChatAccount(account) {
    if (!account || attemptedWebChatAccounts.has(account)) return false;
    attemptedWebChatAccounts.add(account);

    try {
      await tryToRenderWebChat(account);
      return true;
    } catch (error) {
      log('tryToRenderWebChat failed:', account, error?.message || error);
      return false;
    }
  }

  async function initWebChat() {
    if (await tryWebChatAccount(readPageAccount())) return;

    const sessionAccount = await getSessionAccountSafely();
    if (await tryWebChatAccount(sessionAccount?.accountName?.value)) return;
    if (await tryWebChatAccount(sessionAccountId(sessionAccount))) return;

    if (await tryWebChatAccount(await guessVtexAccount())) return;

    watchVtexAccount(tryWebChatAccount);
  }

  function whenWebChatReady() {
    if (!webChatReadyPromise) {
      webChatReadyPromise = new Promise((resolve) => {
        let checks = 0;

        const check = () => {
          try {
            if (window.WebChat) {
              resolve(window.WebChat);
              return;
            }
          } catch {
            // Keep checking on the next tick.
          }

          checks++;
          setTimeout(
            check,
            checks < WEBCHAT_FAST_CHECK_ATTEMPTS ? WEBCHAT_FAST_CHECK_INTERVAL_MS : WEBCHAT_SLOW_CHECK_INTERVAL_MS,
          );
        };

        check();
      });
    }

    return webChatReadyPromise;
  }

  function waitFor(conditions, secondsToRetry = 1, maxAttempts = 30) {
    const conditionArray = Array.isArray(conditions) ? conditions : [conditions];

    return new Promise((resolve, reject) => {
      let attempts = 0;
      const cached = new Array(conditionArray.length);
      const pending = new Set(conditionArray.map((_, index) => index));

      const runCondition = (index) => {
        try {
          return Promise.resolve(conditionArray[index]()).then(
            (value) => ({ index, value, error: null }),
            (error) => ({ index, value: null, error }),
          );
        } catch (error) {
          return Promise.resolve({ index, value: null, error });
        }
      };

      const verify = async () => {
        attempts++;

        const settled = await Promise.all(Array.from(pending, runCondition));

        let lastError = null;

        for (const { index, value, error } of settled) {
          if (error) {
            lastError = error;
            continue;
          }

          if (value) {
            cached[index] = value;
            pending.delete(index);
          }
        }

        if (pending.size === 0) {
          resolve(Array.isArray(conditions) ? cached : cached[0]);
          return;
        }

        if (attempts >= maxAttempts) {
          const message = lastError
            ? `[VTEX CX] Failed and limit of ${maxAttempts} attempts reached. Error: ${lastError.message}`
            : `[VTEX CX] Limit of ${maxAttempts} attempts reached.`;
          reject(new Error(message));
          return;
        }

        setTimeout(verify, secondsToRetry * 1e3);
      };

      verify();
    });
  }

  async function getSegment() {
    try {
      const response = await fetch('/api/segments');

      if (response.ok) {
        const apiSegment = await response.json();

        if (apiSegment) {
          return JSON.stringify(apiSegment);
        }
      }
    } catch (error) {
      log('getSegment: /api/segments request failed:', error?.message || error);
    }

    const fastStoreSegment = window.faststore_sdk_stores?.get("fs::session")?.read?.();

    if (fastStoreSegment) {
      return JSON.stringify(fastStoreSegment);
    }

    const VTEXIOSegment = window.__RUNTIME__?.segmentToken;

    if (VTEXIOSegment) {
      return atob(VTEXIOSegment);
    }

    return null;
  }

  async function getOrderFormId() {
    const fastStoreOrderFormId = window.faststore_sdk_stores?.get('fs::cart')?.read?.()?.id;

    if (fastStoreOrderFormId) {
      return fastStoreOrderFormId;
    }

    try {
      const VTEXIOOrderFormId = localStorage.getItem('orderform') && JSON.parse(localStorage.getItem('orderform')).id;

      if (VTEXIOOrderFormId) {
        return VTEXIOOrderFormId;
      }
    } catch {
      // continue
    }

    return new Promise((resolve, reject) => {
      fetch('/api/checkout/pub/orderForm')
        .then((response) => response.json())
        .then(async (data) => {
          resolve(data.orderFormId);
        }).catch(reject);
    });
  }

  function getUserEmail() {
    const fastStoreEmail = window.faststore_sdk_stores?.get('fs::session')?.read?.()?.person?.email;

    if (fastStoreEmail) {
      return fastStoreEmail;
    }

    try {
      const VTEXIOEmail = localStorage.getItem('orderform') && JSON.parse(localStorage.getItem('orderform'))?.clientProfileData?.email;

      if (VTEXIOEmail) {
        return VTEXIOEmail;
      }
    } catch {
      // continue
    }

    return null;
  }

  async function getValidOrderFormId() {
    const orderFormId = await getOrderFormId();

    if (typeof orderFormId === 'string' && /^[a-fA-F0-9]{32}$/.test(orderFormId)) {
      return orderFormId;
    }

    return null;
  }

  async function getSessionToken() {
    const response = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await response.json();
    return data.sessionToken || null;
  }

  async function watchSessionToken() {
    let lastSessionToken = null;

    const poll = async () => {
      try {
        const sessionToken = await getSessionToken();

        if (sessionToken && sessionToken !== lastSessionToken) {
          lastSessionToken = sessionToken;
          window.WebChat.setCustomField('session', sessionToken);
        }
      } catch (error) {
        log('watchSessionToken: failed to fetch session token:', error?.message || error);
      }

      setTimeout(poll, SESSION_TOKEN_POLL_INTERVAL_MS);
    };

    await whenWebChatReady();
    poll();
  }

  async function setWebChatContextFields() {
    const WebChat = await whenWebChatReady();
    const [segment, orderFormId] = await waitFor([getSegment, getValidOrderFormId]);

    WebChat.setCustomField('segment', segment);
    WebChat.setCustomField('orderform', orderFormId);
  }

  async function setWebChatAccountField() {
    const WebChat = await whenWebChatReady();
    const applyAccountName = (accountName) => {
      WebChat.setCustomField('vtex_account', accountName);
      return true;
    };

    const accountName = await resolveVtexAccountName();
    if (accountName) {
      applyAccountName(accountName);
      return;
    }

    watchVtexAccount(applyAccountName);
  }

  async function setWebChatEmail() {
    const WebChat = await whenWebChatReady();
    const email = await waitFor(getUserEmail, 5, Infinity);

    WebChat.setCustomField('email', email);
  }

  startSafely('message listener', () => window.addEventListener('message', handleEvents));
  startSafely('jQuery integration', listenToJQueryOrderFormUpdates);
  startSafely('notifyAbandonedCart', notifyAbandonedCart);
  startSafely('initWebChat', initWebChat);
  startSafely('watchSessionToken', watchSessionToken);
  startSafely('[VTEX CX] WebChat segment/orderform fields', setWebChatContextFields);
  startSafely('[VTEX CX] WebChat vtex_account field', setWebChatAccountField);
  startSafely('[VTEX CX] WebChat email field', setWebChatEmail);
}
