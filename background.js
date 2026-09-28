const ENABLE_KEY = 'smartedu-autoplay:teacher-courses:enabled';
const LEGACY_ENABLE_KEY = 'smartedu-autoplay:2e001e74-34e1-4b0f-bda9-5350799a91fc:enabled';
const ALARM_NAME = 'smartedu-autoplay-watchdog';

function syncAlarm() {
  chrome.storage.local.get([ENABLE_KEY, LEGACY_ENABLE_KEY], state => {
    if (chrome.runtime.lastError) return;
    const enabled = state[ENABLE_KEY] === true ||
      (state[ENABLE_KEY] === undefined && state[LEGACY_ENABLE_KEY] === true);
    if (enabled) {
      chrome.alarms.get(ALARM_NAME, alarm => {
        if (!chrome.runtime.lastError && !alarm) {
          chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
        }
      });
    } else {
      chrome.alarms.clear(ALARM_NAME);
    }
  });
}

chrome.runtime.onInstalled.addListener(syncAlarm);
chrome.runtime.onStartup.addListener(syncAlarm);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes[ENABLE_KEY] || changes[LEGACY_ENABLE_KEY])) syncAlarm();
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== ALARM_NAME) return;
  chrome.tabs.query({ url: 'https://www.smartedu.cn/jiaoshi/*' }, tabs => {
    if (chrome.runtime.lastError) return;
    for (const tab of tabs) {
      if (tab.id === undefined || tab.discarded || tab.frozen) continue;
      chrome.tabs.sendMessage(tab.id, { type: 'WAKE' }, () => void chrome.runtime.lastError);
    }
  });
});
