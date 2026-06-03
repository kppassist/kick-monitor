// Content Script - Kick Monitor
// Runs on kick.com pages to handle chat automation

(function () {
  'use strict';

  let settings = {};
  let chatObserver = null;
  let recentMessages = [];   // { text, timestamp } — used only for W-spam detection (4s window)
  let parrotPool = [];       // rolling buffer of clean message strings for parrot mode
  const PARROT_POOL_SIZE = 200;
  const PARROT_MIN_POOL  = 15;

  const BOT_USERNAMES = new Set([
    'kickbot', 'botrix', 'streamelements', 'nightbot', 'moobot',
    'fossabot', 'wizebot', 'ohbot', 'deepbot', 'phantombot',
    'commanderroot', 'electricallongboard', 'soundalerts', 'kofistreambot',
    'streamlabs', 'continuity', 'owncast', 'sery_bot', 'stormstreamer', 'pepperpal'
  ]);

  // ── Random emote state ──
  let globalEmotes = [];
  let emoteInterval = null;
  let initialized = false;

  // ── Canned phrase state ──
  let cannedInterval = null;

  // ── Live status ──
  let streamerIsLive = true; // optimistic; background corrects within ~1 min

  function getCurrentUsername() {
    const match = location.pathname.match(/^\/([^/?#]+)/);
    return match ? match[1].toLowerCase() : null;
  }

  loadSettings().then(() => {
    fetchGlobalEmotes();
    waitForChat();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'SETTINGS_UPDATED') {
      settings = message.settings;
      applySettings();
    }

    if (message.type === 'STREAMER_STATUS_UPDATE') {
      const username = getCurrentUsername();
      if (username && message.username.toLowerCase() === username) {
        const wasLive = streamerIsLive;
        streamerIsLive = message.isLive;
        if (!streamerIsLive && wasLive) {
          console.log('[KickMonitor] ストリーマーがオフラインになりました。タイマーを一時停止します。');
          stopEmoteTimer();
          stopCannedTimer();
        } else if (streamerIsLive && !wasLive) {
          console.log('[KickMonitor] ストリーマーがオンラインになりました。タイマーを再開します。');
          applySettings();
        }
      }
    }
  });

  function loadSettings() {
    return new Promise(resolve => {
      chrome.storage.local.get(['settings'], (data) => {
        settings = data.settings || {};
        resolve();
      });
    });
  }

  function waitForChat() {
    const interval = setInterval(() => {
      const chatContainer = getChatContainer();
      if (chatContainer && !initialized) {
        initialized = true;
        clearInterval(interval);
        console.log('[KickMonitor] チャット検出、機能を初期化中。');
        applySettings();
        observeChat(chatContainer);
      }
    }, 2000);
  }

  function getChatContainer() {
    return (
      document.querySelector('[data-testid="chat-messages"]') ||
      document.querySelector('.chat-messages-wrapper') ||
      document.querySelector('#chatroom-messages') ||
      document.querySelector('.chat-message-list') ||
      document.querySelector('[class*="chat-messages"]') ||
      document.querySelector('[class*="chatroom"]')
    );
  }

  function getChatInput() {
    return (
      document.querySelector('[data-testid="chat-input"]') ||
      document.querySelector('.chat-input') ||
      document.querySelector('[placeholder*="Send a message"]') ||
      document.querySelector('[contenteditable="true"][class*="chat"]') ||
      document.querySelector('div[contenteditable="true"]')
    );
  }

  function applySettings() {
    if (settings.randomEmote) {
      startEmoteTimer();
    } else {
      stopEmoteTimer();
    }
    if (settings.cannedPhrasesEnabled && settings.cannedPhrases && settings.cannedPhrases.length > 0) {
      startCannedTimer();
    } else {
      stopCannedTimer();
    }
  }

  // ─── RANDOM GLOBAL EMOTE ─────────────────────────────────────────────────

  function fetchGlobalEmotes() {
    globalEmotes = [
      'beeBobble','Bwop','CaptFail','catblobDance','catKISS','classic',
      'EDDIE','EZ','Flowie','HYPERCLAP','KEKW','mericCat','NODDERS',
      'OOOO','OuttaPocket','PatrickBoo','PeepoClap','peepoDJ','peepoShy',
      'PogU','politeCat'
    ];
  }

  function startEmoteTimer() {
    if (emoteInterval) return;
    scheduleNextEmote();
  }

  function stopEmoteTimer() {
    if (emoteInterval) {
      clearTimeout(emoteInterval);
      emoteInterval = null;
    }
  }

  function scheduleNextEmote() {
    if (!settings.randomEmote) return;
    const delay = 120000 + Math.random() * 180000;
    emoteInterval = setTimeout(() => {
      emoteInterval = null;
      if (settings.randomEmote && streamerIsLive && globalEmotes.length > 0) {
        const emote = globalEmotes[Math.floor(Math.random() * globalEmotes.length)];
        sendChatMessage(emote);
        console.log(`[KickMonitor] ランダムエモート送信: ${emote}`);
      }
      scheduleNextEmote();
    }, delay);
  }

  // ─── CANNED PHRASES ───────────────────────────────────────────────────────

  function startCannedTimer() {
    if (cannedInterval) return;
    scheduleNextCannedPhrase();
  }

  function stopCannedTimer() {
    if (cannedInterval) {
      clearTimeout(cannedInterval);
      cannedInterval = null;
    }
  }

  function scheduleNextCannedPhrase() {
    if (!settings.cannedPhrasesEnabled) return;
    const phrases = settings.cannedPhrases || [];
    if (phrases.length === 0) return;
    // 2–5 minute random interval
    const delay = 120000 + Math.random() * 180000;
    cannedInterval = setTimeout(() => {
      cannedInterval = null;
      if (settings.cannedPhrasesEnabled && streamerIsLive && phrases.length > 0) {
        const phrase = phrases[Math.floor(Math.random() * phrases.length)];
        sendChatMessage(phrase);
        console.log(`[KickMonitor] 定型文送信: ${phrase}`);
      }
      scheduleNextCannedPhrase();
    }, delay);
  }

  // ─── CHAT OBSERVER ────────────────────────────────────────────────────────

  function observeChat(container) {
    if (chatObserver) chatObserver.disconnect();

    chatObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const msgText = extractMessageText(node);
          if (!msgText) continue;
          const sender = extractSenderName(node);
          handleNewMessage(msgText, sender, node);
        }
      }
    });

    chatObserver.observe(container, { childList: true, subtree: true });
    console.log('[KickMonitor] チャット監視開始。');
  }

  function cleanMessageText(text) {
    return text
      .replace(/^\d{1,2}:\d{2}\s*[AP]M\s*/i, '')
      .replace(/^[AP]M\s+/i, '')
      .replace(/^global\s+/i, '')
      .replace(/^@?[\w\-\.]{1,30}:\s*/, '')
      .trim();
  }

  function extractMessageText(node) {
    const contentEl = (
      node.querySelector('[data-testid="chat-message-content"]') ||
      node.querySelector('[class*="message-content"]') ||
      node.querySelector('[class*="chat-entry-content"]') ||
      node.querySelector('[class*="message-text"]')
    );

    const source = contentEl || node;
    const clone = source.cloneNode(true);

    // Remove timestamp/username/badge elements (only needed on full-node fallback,
    // but harmless to run on contentEl clones too)
    clone.querySelectorAll(
      'time, [class*="timestamp"], [class*="time"], [data-testid*="time"]'
    ).forEach(el => el.remove());
    clone.querySelectorAll(
      '[class*="username"], [class*="sender"], [class*="author"], ' +
      '[class*="badge"], [class*="chat-entry-username"], ' +
      '[data-testid*="username"], [data-testid*="sender"]'
    ).forEach(el => el.remove());

    // Replace each emote img with " emoteName " so words don't run together
    clone.querySelectorAll('img').forEach(img => {
      const name = img.alt?.trim() || '';
      img.replaceWith(document.createTextNode(name ? ` ${name} ` : ' '));
    });

    // Collapse runs of whitespace to a single space
    const text = (clone.textContent || '').replace(/\s+/g, ' ').trim();
    return cleanMessageText(text);
  }

  function extractSenderName(node) {
    const senderEl = (
      node.querySelector('[data-testid="chat-entry-username"]') ||
      node.querySelector('[class*="username"]') ||
      node.querySelector('[class*="sender"]') ||
      node.querySelector('[class*="author"]')
    );
    return senderEl?.textContent?.trim().toLowerCase().replace(/^@/, '') || '';
  }

  // ─── MESSAGE HANDLING ────────────────────────────────────────────────────

  function handleNewMessage(text, sender, node) {
    const now = Date.now();

    recentMessages.push({ text, timestamp: now });
    recentMessages = recentMessages.filter(m => now - m.timestamp <= 4000);

    const isWSpam = /^w+$/i.test(text.trim());
    const isCommand = text.startsWith('$') || text.startsWith('!');
    const isBot = sender && BOT_USERNAMES.has(sender);
    const isTimestampArtifact = /[AP]MLevel/i.test(text);
    const isUIArtifact = /^(global|am|pm)$/i.test(text.trim());
    const isUILeakage = /subscriber|subscribed|level|redeemed/i.test(text);
    // reject if text is just a username (no spaces, looks like a handle)
    const isBareName = /^@?[\w\-\.]{1,30}$/.test(text.trim()) && !/\s/.test(text.trim());
    if (!isWSpam && !isCommand && !isBot && !isTimestampArtifact && !isUIArtifact && !isUILeakage && !isBareName && text.length >= 3 && text.length <= 200) {
      parrotPool.push(text);
      if (parrotPool.length > PARROT_POOL_SIZE) parrotPool.shift();
    }

    if (settings.wSpam) {
      checkWSpam(text, now);
    }

    if (settings.parrot) {
      checkParrot();
    }
  }

  // ─── W SPAM ──────────────────────────────────────────────────────────────

  function checkWSpam(text, now) {
    const wPattern = /^w+$/i;
    const cleanText = text.trim();
    if (!wPattern.test(cleanText)) return;

    const wMessages = recentMessages.filter(m => wPattern.test(m.text.trim()));
    if (wMessages.length >= 5) {
      const totalWs = wMessages.reduce((sum, m) => sum + m.text.trim().length, 0);
      const avgWs = Math.round(totalWs / wMessages.length);
      const wString = 'W'.repeat(Math.max(1, avgWs));

      const lastSent = window.__kickMonitorLastW || 0;
      if (now - lastSent > 3000) {
        window.__kickMonitorLastW = now;
        sendChatMessage(wString);
      }
    }
  }

  // ─── PARROT ──────────────────────────────────────────────────────────────

  let parrotCooldown = false;
  let lastParrotedText = null;

  function checkParrot() {
    if (parrotCooldown) return;
    if (parrotPool.length < PARROT_MIN_POOL) return;
    if (Math.random() > 0.15) return;

    const safePool = parrotPool.length > 10 ? parrotPool.slice(0, -5) : parrotPool;
    const pick = safePool[Math.floor(Math.random() * safePool.length)];

    if (!pick || pick === lastParrotedText) return;

    parrotCooldown = true;
    lastParrotedText = pick;
    const cooldown = 15000 + Math.random() * 20000;
    setTimeout(() => { parrotCooldown = false; }, cooldown);

    const delay = 2000 + Math.random() * 4000;
    setTimeout(() => {
      sendChatMessage(pick);
    }, delay);
  }

  // ─── SEND CHAT MESSAGE ───────────────────────────────────────────────────

  function sendChatMessage(text) {
    const input = getChatInput();
    if (!input) {
      console.warn('[KickMonitor] チャット入力欄が見つかりません。');
      return;
    }

    input.focus();

    if (input.getAttribute('contenteditable') === 'true') {
      input.textContent = '';
      document.execCommand('insertText', false, text);
    } else {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set || Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      )?.set;

      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    setTimeout(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true
      }));
      input.dispatchEvent(new KeyboardEvent('keyup', {
        key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true
      }));

      const sendBtn = (
        document.querySelector('[data-testid="chat-send-button"]') ||
        document.querySelector('button[type="submit"][class*="chat"]') ||
        document.querySelector('[class*="send-button"]') ||
        document.querySelector('[aria-label*="send" i]')
      );
      if (sendBtn) sendBtn.click();
    }, 100);
  }

  // Re-initialize on SPA navigation
  let lastUrl = location.href;
  new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
      lastUrl = url;
      initialized = false;
      recentMessages = [];
      parrotPool = [];
      lastParrotedText = null;
      stopEmoteTimer();
      stopCannedTimer();
      if (settings.randomEmote) startEmoteTimer();
      if (chatObserver) { chatObserver.disconnect(); chatObserver = null; }
      setTimeout(waitForChat, 2000);
    }
  }).observe(document, { subtree: true, childList: true });

})();
