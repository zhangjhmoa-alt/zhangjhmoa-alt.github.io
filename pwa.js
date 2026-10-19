(() => {
  "use strict";

  const isSecureContextForWorker = location.protocol === "https:"
    || ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  if (!("serviceWorker" in navigator) || !isSecureContextForWorker) return;

  const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches
    || window.navigator.standalone === true;
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const DISMISS_KEY = "lexiloop-install-hint-dismissed";
  const HINT_DELAY_MS = 1800;
  const HINT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

  let deferredInstallPrompt = null;
  let notice = null;
  let registration = null;
  let isReloading = false;

  function addNoticeStyles() {
    if (document.getElementById("lexiloopPwaStyles")) return;
    const style = document.createElement("style");
    style.id = "lexiloopPwaStyles";
    style.textContent = `
      .pwa-notice{position:fixed;z-index:150;right:calc(16px + env(safe-area-inset-right,0px));bottom:calc(16px + env(safe-area-inset-bottom,0px));width:min(390px,calc(100vw - 32px));padding:15px 16px;border:1px solid rgba(121,210,196,.35);border-radius:16px;color:#eef8f5;background:#102a2e;box-shadow:0 18px 55px rgba(10,28,31,.28);font:12px/1.55 system-ui,-apple-system,"PingFang SC",sans-serif}
      .pwa-notice[hidden]{display:none}.pwa-notice strong{display:block;margin-bottom:3px;font:700 15px/1.35 Georgia,"Songti SC",serif}.pwa-notice p{margin:0;color:#c7d9d5}.pwa-notice-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:11px}.pwa-notice button{min-height:40px;padding:8px 13px;border:1px solid rgba(255,255,255,.18);border-radius:10px;color:#dceae7;background:transparent;cursor:pointer;font:700 12px system-ui,-apple-system,"PingFang SC",sans-serif}.pwa-notice button[data-primary]{border-color:#79d2c4;color:#102a2e;background:#79d2c4}
      @media(max-width:560px){.pwa-notice{right:calc(10px + env(safe-area-inset-right,0px));bottom:calc(10px + env(safe-area-inset-bottom,0px));width:calc(100vw - 20px)}}
    `;
    document.head.append(style);
  }

  function ensureNotice() {
    if (notice) return notice;
    addNoticeStyles();
    notice = document.createElement("aside");
    notice.className = "pwa-notice";
    notice.hidden = true;
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");
    document.body.append(notice);
    return notice;
  }

  function hideNotice() {
    if (notice) notice.hidden = true;
  }

  function showNotice({ title, message, primaryLabel, onPrimary, secondaryLabel = "稍后", onSecondary }) {
    const panel = ensureNotice();
    panel.replaceChildren();

    const titleNode = document.createElement("strong");
    titleNode.textContent = title;
    const messageNode = document.createElement("p");
    messageNode.textContent = message;
    const actions = document.createElement("div");
    actions.className = "pwa-notice-actions";

    if (secondaryLabel) {
      const secondary = document.createElement("button");
      secondary.type = "button";
      secondary.textContent = secondaryLabel;
      secondary.addEventListener("click", () => {
        hideNotice();
        onSecondary?.();
      });
      actions.append(secondary);
    }

    const primary = document.createElement("button");
    primary.type = "button";
    primary.dataset.primary = "true";
    primary.textContent = primaryLabel;
    primary.addEventListener("click", onPrimary, { once: true });
    actions.append(primary);

    panel.append(titleNode, messageNode, actions);
    panel.hidden = false;
  }

  function dismissInstallHint() {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* storage may be disabled */ }
  }

  function installHintIsCoolingDown() {
    try {
      return Date.now() - Number(localStorage.getItem(DISMISS_KEY) || 0) < HINT_COOLDOWN_MS;
    } catch {
      return false;
    }
  }

  async function requestPersistentStorage() {
    try { await navigator.storage?.persist?.(); } catch { /* optional browser feature */ }
  }

  function offerChromiumInstall() {
    if (!deferredInstallPrompt || isStandalone() || installHintIsCoolingDown()) return;
    showNotice({
      title: "安装词脉，断网也能背词",
      message: "安装不需要登录，学习数据仍只保存在你的设备上。",
      primaryLabel: "安装",
      onPrimary: async () => {
        const prompt = deferredInstallPrompt;
        deferredInstallPrompt = null;
        hideNotice();
        await requestPersistentStorage();
        await prompt.prompt();
        const choice = await prompt.userChoice;
        if (choice.outcome !== "accepted") dismissInstallHint();
      },
      onSecondary: dismissInstallHint
    });
  }

  function offerIosInstall() {
    if (!isIos || isStandalone() || installHintIsCoolingDown()) return;
    showNotice({
      title: "添加到主屏幕，断网也能使用",
      message: "在 Safari 中点“分享”，再选“添加到主屏幕”。首次请保持联网，等待页面完整打开。",
      primaryLabel: "知道了",
      secondaryLabel: null,
      onPrimary: () => {
        dismissInstallHint();
        hideNotice();
        requestPersistentStorage();
      }
    });
  }

  function offerUpdate(worker) {
    showNotice({
      title: "词脉有新版本",
      message: "更新不会删除当前设备上的学习进度。",
      primaryLabel: "立即更新",
      onPrimary: () => {
        hideNotice();
        worker.postMessage({ type: "SKIP_WAITING" });
      }
    });
  }

  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    window.setTimeout(offerChromiumInstall, HINT_DELAY_MS);
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    dismissInstallHint();
    hideNotice();
  });

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (isReloading) return;
    isReloading = true;
    location.reload();
  });

  navigator.serviceWorker.register("./sw.js", { scope: "./", updateViaCache: "none" })
    .then(result => {
      registration = result;
      if (registration.waiting && navigator.serviceWorker.controller) offerUpdate(registration.waiting);

      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) offerUpdate(worker);
        });
      });

      // Browsers normally check automatically on navigation; this also catches
      // a tab that stayed open while connectivity returned.
      window.addEventListener("online", () => registration.update().catch(() => {}));
      window.setTimeout(() => registration.update().catch(() => {}), 6000);
      window.setTimeout(offerIosInstall, HINT_DELAY_MS);
    })
    .catch(error => console.warn("LexiLoop offline support could not start:", error));
})();

