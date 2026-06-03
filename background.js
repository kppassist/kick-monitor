// Background Service Worker - Kick Monitor

const POLL_INTERVAL_MINUTES = 1;
const KICK_API_BASE = 'https://kick.com/api/v2/channels';

// Track which streamers we already opened tabs for
let openedTabs = {};
let liveStatus = {};

// Initialize alarm for polling
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('pollStreamers', { periodInMinutes: POLL_INTERVAL_MINUTES });
  console.log('[KickMonitor] Extension installed, polling alarm created.');
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'pollStreamers') {
    pollAllStreamers();
  }
});

// Also poll immediately when the background wakes
pollAllStreamers();

async function pollAllStreamers() {
  const data = await getStorage(['streamers', 'settings']);
  const streamers = data.streamers || [];
  const settings = data.settings || {};

  if (streamers.length === 0) return;

  for (const streamer of streamers) {
    try {
      const response = await fetch(`${KICK_API_BASE}/${streamer.username}`, {
        headers: { 'Accept': 'application/json' }
      });

      if (!response.ok) continue;

      const channelData = await response.json();
      const isLive = channelData?.livestream !== null && channelData?.livestream !== undefined;
      const wasLive = liveStatus[streamer.username] || false;

      liveStatus[streamer.username] = isLive;

      // Update streamer info in storage
      const updatedStreamers = streamers.map(s => {
        if (s.username === streamer.username) {
          return {
            ...s,
            isLive,
            viewerCount: channelData?.livestream?.viewer_count || 0,
            streamTitle: channelData?.livestream?.session_title || '',
            avatarUrl: channelData?.user?.profile_pic || s.avatarUrl || '',
            lastChecked: Date.now()
          };
        }
        return s;
      });

      await setStorage({ streamers: updatedStreamers });

      // Auto-open tab logic
      if (isLive && settings.autoOpenTabs) {
        const streamUrl = `https://kick.com/${streamer.username}`;
        const existingTabs = await new Promise(resolve =>
          chrome.tabs.query({ url: `${streamUrl}*` }, resolve)
        );

        if (existingTabs.length === 0) {
          // Tab isn't open — either they just went live, or user manually closed it
          const justWentLive = !wasLive;
          const tabWasClosed = wasLive && settings.reopenClosedTabs;

          if (justWentLive || tabWasClosed) {
            chrome.tabs.create({ url: streamUrl, active: false });
            console.log(`[KickMonitor] Opened tab for ${streamer.username} (${justWentLive ? 'went live' : 'tab was closed'})`);
          }
        }
      }

      // Clear live status when they go offline
      if (!isLive && wasLive) {
        delete openedTabs[streamer.username];
      }

      // Notify popup of status update
      chrome.runtime.sendMessage({
        type: 'STREAMER_STATUS_UPDATE',
        username: streamer.username,
        isLive,
        viewerCount: channelData?.livestream?.viewer_count || 0,
        streamTitle: channelData?.livestream?.session_title || ''
      }).catch(() => {}); // Popup may be closed

    } catch (err) {
      console.warn(`[KickMonitor] Failed to fetch ${streamer.username}:`, err);
    }
  }
}

// Message handler from popup/content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'POLL_NOW') {
    pollAllStreamers().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === 'GET_LIVE_STATUS') {
    sendResponse({ liveStatus });
    return true;
  }

  if (message.type === 'OPEN_STREAM') {
    chrome.tabs.create({ url: `https://kick.com/${message.username}`, active: true });
    sendResponse({ ok: true });
  }
});

// Helpers
function getStorage(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function setStorage(data) {
  return new Promise(resolve => chrome.storage.local.set(data, resolve));
}
