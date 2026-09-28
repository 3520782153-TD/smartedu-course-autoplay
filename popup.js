const statusNode = document.getElementById('status');
const diagnosticsNode = document.getElementById('diagnostics');
const modeNode = document.getElementById('mode');
const courseNode = document.getElementById('course');
const speedNode = document.getElementById('speed');
const displayCapNode = document.getElementById('display-cap');
const buttons = ['start', 'pause', 'stop', 'preview', 'test-next'].map(id => document.getElementById(id));
let currentTabId = null;

function show(text) {
  statusNode.textContent = text;
}

function setEnabled(enabled) {
  for (const button of buttons) button.disabled = !enabled;
  speedNode.disabled = !enabled;
  displayCapNode.disabled = !enabled;
}

function request(type, payload = {}) {
  if (currentTabId === null) return;
  chrome.tabs.sendMessage(currentTabId, { type, ...payload }, response => {
    if (chrome.runtime.lastError || !response) {
      show('无法连接课程页面。请刷新页面后重试。');
      return;
    }
    show(response.preview || response.status);
    courseNode.textContent = response.courseId
      ? `当前课程 ID：${response.courseId}`
      : '适用于智慧教育教师发展中心课程页';
    modeNode.textContent = response.active
      ? `连播：已开启${response.holdKind ? '（等待处理）' : ''}`
      : '连播：未开启';
    diagnosticsNode.textContent = response.diagnostics || '';
    if (response.speed !== undefined) speedNode.value = String(response.speed);
    if (response.displayCap !== undefined) displayCapNode.checked = response.displayCap;
    setEnabled(response.supported);
  });
}

chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
  const tab = tabs[0];
  if (!tab || !tab.url?.startsWith('https://www.smartedu.cn/jiaoshi/')) {
    show('请先切换到智慧教育教师发展中心课程页。');
    setEnabled(false);
    return;
  }
  currentTabId = tab.id;
  request('STATUS');
});

document.getElementById('start').addEventListener('click', () => request('START'));
document.getElementById('pause').addEventListener('click', () => request('PAUSE'));
document.getElementById('stop').addEventListener('click', () => request('STOP'));
document.getElementById('preview').addEventListener('click', () => request('PREVIEW'));
document.getElementById('test-next').addEventListener('click', () => request('TEST_NEXT'));
speedNode.addEventListener('change', () => request('SET_SPEED', { speed: Number(speedNode.value) }));
displayCapNode.addEventListener('change', () => request('SET_DISPLAY_CAP', { enabled: displayCapNode.checked }));
