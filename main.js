/**
* agentic-cx v1.2.0
* https://github.com/weni-ai/agentic-cx
**/

if (!window.agenticCXScriptAlreadyInserted) {
  window.agenticCXScriptAlreadyInserted = true;

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

  const timeToCallNextAbandonedCartUpdateInSeconds = 15 * 60; // 15 minutes
  let seeOrderFormTimeout;

  function getDetails() {
    return new Promise((resolve, reject) => {
      fetch('/api/sessions?items=*')
        .then((response) => response.json())
        .then((data) => {
          log('got user data:', JSON.safeStringify(data.namespaces?.profile, 2));
          resolve({
            profile: data.namespaces?.profile,
            account: data.namespaces?.account,
          });
        })
        .catch(reject);
    });
  }

  function seeOrderForm() {
    log('calling seeOrderForm function');

    clearTimeout(seeOrderFormTimeout);

    fetch('/api/checkout/pub/orderForm')
      .then((response) => response.json())
      .then(async (data) => {
        seeOrderFormTimeout = setTimeout(
          seeOrderForm,
          timeToCallNextAbandonedCartUpdateInSeconds * 1e3
        );

        const { profile, account } = await getDetails();

        const phone = profile?.phone?.value || data?.clientProfileData?.phone;
        const name = profile?.firstName?.value || data?.clientProfileData?.firstName || profile?.lastName?.value;
        const accountName = window.__RUNTIME__?.account || account?.accountName?.value;
        const cart_id = data?.orderFormId;

        if (!accountName) {
          log('seeOrderForm: missing accountName, skipping abandoned cart notification');
          return;
        }

        if (!cart_id || !phone || !name) {
          log('seeOrderForm: missing cart_id, phone or name, skipping abandoned cart notification');
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
      .catch((error) => log('seeOrderForm failed:', error?.message || error));
  }

  function handleEvents(e) {
    const eventName = e.data?.eventName;
    switch (eventName) {
      case 'vtex:addToCart': {
        seeOrderForm();
        return;
      }
    }
  }

  window.addEventListener('message', handleEvents);

  try {
    if (typeof $ === 'function') {
      const $win = $(window);
      if ($win && typeof $win.on === 'function') {
        const seeOrderFormThrottled = throttle(seeOrderForm, 3e3);
        $win.on('orderFormUpdated.vtex', seeOrderFormThrottled);
      }
    }
  } catch (error) {
    log('jQuery integration skipped:', error?.message || error);
  }

  try {
    seeOrderForm();
  } catch (error) {
    log('initial seeOrderForm threw synchronously:', error?.message || error);
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

  initWebChat();

  function initWebChat() {
    // FastStore or VTEX IO
    const account = window.VTEX_METADATA?.account || window.__RUNTIME__?.account;

    if (account) {
      tryToRenderWebChat(account).catch(initWebChatWithAccountId);
      return;
    }

    initWebChatWithAccountId();
  }

  function initWebChatWithAccountId() {
    getDetails()
      .then(({ account }) => {
        const rawAccountId = account?.id?.value;
        const accountId = typeof rawAccountId === 'string' ? rawAccountId.replace(/-/g, '') : rawAccountId;

        if (accountId) {
          tryToRenderWebChat(accountId).catch((error) => log('tryToRenderWebChat failed:', error?.message || error));
        }
      })
      .catch((error) => log('initWebChatWithAccountId failed:', error?.message || error));
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

  function watchSessionToken() {
    let lastSessionToken = null;

    const poll = async () => {
      if (!window.WebChat) {
        setTimeout(poll, 5 * 1e3);
        return;
      }

      try {
        const sessionToken = await getSessionToken();

        if (sessionToken && sessionToken !== lastSessionToken) {
          lastSessionToken = sessionToken;
          window.WebChat.setCustomField('session', sessionToken);
        }
      } catch (error) {
        log('watchSessionToken: failed to fetch session token:', error?.message || error);
      }

      setTimeout(poll, 20 * 1e3);
    };

    poll();
  }

  watchSessionToken();

  waitFor([
    () => window.WebChat,
    getSegment,
    getValidOrderFormId,
  ]).then(([WebChat, segment, orderFormId]) => {
    WebChat.setCustomField('segment', segment);
    WebChat.setCustomField('orderform', orderFormId);
  }).catch((error) => {
    log('[VTEX CX] failed to set WebChat custom fields:', error?.message || error);
  });

  waitFor([
    () => window.WebChat,
    getUserEmail,
  ], 5, Infinity).then(([WebChat, email]) => {
    WebChat.setCustomField('email', email);
  }).catch((error) => {
    log('[VTEX CX] failed to set WebChat email field:', error?.message || error);
  });
}
