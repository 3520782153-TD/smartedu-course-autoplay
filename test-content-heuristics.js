const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8');
function section(from, to) {
  const start = source.indexOf(`  function ${from}(`);
  const end = source.indexOf(`  function ${to}(`, start);
  assert.ok(start >= 0 && end > start, `Cannot extract ${from}…${to}`);
  return source.slice(start, end);
}

const courseSession = new Map();
const courseContext = vm.createContext({
  URL,
  location: { hostname: 'www.smartedu.cn', pathname: '/jiaoshi/courseDetail',
    href: 'https://www.smartedu.cn/jiaoshi/courseDetail?courseId=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
  SESSION_COURSE: 'course',
  currentCourseId: '',
  courseGeneration: 0,
  active: true,
  video: null,
  resumeTimer: 0,
  window: { clearTimeout() {} },
  readSession(key) { return courseSession.get(key) || null; },
  writeSession(key, value) { courseSession.set(key, value); },
  disableDisplayCap() {},
  setStatus() {}
});
vm.runInContext(section('validCourseId', 'visible'), courseContext);
assert.equal(vm.runInContext('supported()', courseContext), true);
assert.equal(courseContext.currentCourseId, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
courseContext.location.href = 'https://www.smartedu.cn/jiaoshi/courseIndex?courseId=bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
courseContext.location.pathname = '/jiaoshi/courseIndex';
assert.equal(vm.runInContext('supported()', courseContext), true);
assert.equal(courseContext.currentCourseId, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
assert.equal(courseContext.courseGeneration, 2);
courseContext.location.href = 'https://www.smartedu.cn/jiaoshi/home';
courseContext.location.pathname = '/jiaoshi/home';
assert.equal(vm.runInContext('supported()', courseContext), false);
assert.equal(courseContext.currentCourseId, '');
courseContext.location.href = 'https://www.smartedu.cn/jiaoshi/courseDetail';
courseContext.location.pathname = '/jiaoshi/courseDetail';
assert.equal(vm.runInContext('supported()', courseContext), true);
courseContext.location.href = 'https://www.smartedu.cn/jiaoshi/courseDetail?courseId=%3Cbad%3E';
assert.equal(vm.runInContext('supported()', courseContext), false);

const genericRowContext = vm.createContext({
  labelOf: item => item.textContent,
  bestClickTarget: item => item,
  ordinalTitle: () => null
});
vm.runInContext(section('hasLessonCue', 'findNextListItem'), genericRowContext);
const makeRow = (className, textContent) => ({
  className, textContent, parentElement: null,
  getAttribute() { return null; },
  querySelector() { return null; },
  getBoundingClientRect() { return { left: 1300, width: 360, height: 52 }; }
});
const currentGeneric = makeRow('lesson-item active', '课程导论');
const nextGeneric = makeRow('lesson-item', '教学方法与实践');
genericRowContext.current = currentGeneric;
genericRowContext.next = nextGeneric;
assert.equal(vm.runInContext('plausibleNextLesson(current, next)', genericRowContext), true);
genericRowContext.next = makeRow('chapter-item', '第二章');
assert.equal(vm.runInContext('plausibleNextLesson(current, next)', genericRowContext), false);

function catalogItem(doc, text, index, highlighted = false) {
  return {
    ownerDocument: doc,
    innerText: text,
    textContent: text,
    index,
    highlighted,
    parentElement: null,
    nextElementSibling: null,
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 1350, width: 270, height: 55 }; },
    matches() { return false; },
    compareDocumentPosition(other) { return other.index > index ? 4 : 2; }
  };
}

function selectNext(items, withHeading = false) {
  const doc = { querySelectorAll() { return items; } };
  for (const item of items) item.ownerDocument = doc;
  const heading = { getBoundingClientRect() { return { left: 1290 }; } };
  const context = vm.createContext({
    documents: () => [doc],
    findCatalogHeading: () => heading,
    visible: () => true,
    innerWidth: 2048,
    labelOf: element => element.innerText,
    blueText: element => element.highlighted,
    blueBackground: () => false,
    ACTIVE_SELECTOR: '.active',
    clickTargetFor: element => element,
    getComputedStyle: () => ({ cursor: 'pointer' }),
    playableControl: () => true,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 }
  });
  vm.runInContext(section('ordinalNumber', 'findNextControl'), context);
  const selection = vm.runInContext('ordinalSelection()', context);
  return withHeading
    ? { selection, heading: vm.runInContext('findNextGroupHeading()', context) }
    : selection;
}

const sameGroup = [
  catalogItem(null, '做一名躬耕教坛、强国有我的教师（六）', 0, true),
  catalogItem(null, '做一名躬耕教坛、强国有我的教师（七）', 1),
  catalogItem(null, '中国共产党人精神谱系的赓续与教育家精神的弘扬（一）', 2)
];
assert.equal(selectNext(sameGroup).next, sameGroup[1]);

const numberedLessons = [
  catalogItem(null, '1.1 课程导论', 0, true),
  catalogItem(null, '1.2 教学方法', 1)
];
assert.equal(selectNext(numberedLessons).next, numberedLessons[1]);
const lectureLessons = [
  catalogItem(null, '第1讲 教育理念', 0, true),
  catalogItem(null, '第2讲 教学实践', 1)
];
assert.equal(selectNext(lectureLessons).next, lectureLessons[1]);

const acrossHeading = [
  catalogItem(null, '做一名躬耕教坛、强国有我的教师（七）', 0, true),
  catalogItem(null, '中国共产党人精神谱系的赓续与教育家精神的弘扬（一）', 1),
  catalogItem(null, '中国共产党人精神谱系的赓续与教育家精神的弘扬（二）', 2)
];
assert.equal(selectNext(acrossHeading).next, acrossHeading[1]);

const collapsedGroup = [
  catalogItem(null, '做一名躬耕教坛、强国有我的教师（七）', 0, true),
  catalogItem(null, '中国共产党人精神谱系的赓续与教育家精神的弘扬', 1, true),
  catalogItem(null, '另一组课程内容（一）', 2)
];
collapsedGroup[0].nextElementSibling = collapsedGroup[1];
const collapsedPlan = selectNext(collapsedGroup, true);
assert.equal(collapsedPlan.selection.next, null);
assert.equal(collapsedPlan.heading, collapsedGroup[1]);

let clicks = 0;
const phrase = '须学习完课程的视频才可获得该课程视频的学时';
const button = {
  textContent: '我知道了',
  click() { clicks++; },
  getBoundingClientRect() { return { width: 90, height: 40 }; }
};
const container = {
  textContent: phrase + '我知道了',
  parentElement: null,
  querySelectorAll() { return [button]; }
};
const message = {
  textContent: phrase,
  parentElement: container,
  querySelectorAll() { return []; }
};
const noticeDocument = { querySelectorAll() { return [message]; } };
const noticeContext = vm.createContext({
  documents: () => [noticeDocument],
  visible: () => true,
  labelOf: element => element.textContent,
  clickTargetFor: element => element,
  lastNoticeButton: null,
  lastNoticeClick: 0,
  noticeFirstSeen: 0,
  active: true,
  lastAttempt: 'episode',
  setStatus() {},
  holdAutomation() {}
});
vm.runInContext(section('studyNoticeButton', 'speedWarningVisible'), noticeContext);
assert.equal(vm.runInContext('dismissStudyNotice()', noticeContext), true);
assert.equal(clicks, 1);
assert.equal(vm.runInContext('dismissStudyNotice()', noticeContext), true);
assert.equal(clicks, 1);

const inputContext = vm.createContext({ labelOf: element => element?.textContent || '' });
vm.runInContext(section('isManualPauseInput', 'observeManualPause'), inputContext);
const fakeVideo = {
  nodeType: 1,
  contains() { return false; },
  getBoundingClientRect() { return { left: 300, bottom: 820 }; }
};
const genericTarget = { nodeType: 1, closest() { return null; } };
inputContext.currentVideo = fakeVideo;
inputContext.inputEvent = { type: 'pointerdown', target: genericTarget, clientX: 325, clientY: 800 };
assert.equal(vm.runInContext('isManualPauseInput(inputEvent, currentVideo)', inputContext), true);
inputContext.inputEvent = { type: 'pointerdown', target: genericTarget, clientX: 900, clientY: 500 };
assert.equal(vm.runInContext('isManualPauseInput(inputEvent, currentVideo)', inputContext), false);
inputContext.inputEvent = { type: 'keydown', key: ' ', target: { closest() { return null; } } };
assert.equal(vm.runInContext('isManualPauseInput(inputEvent, currentVideo)', inputContext), true);
inputContext.inputEvent = { type: 'keydown', key: ' ', target: { closest() { return {}; } } };
assert.equal(vm.runInContext('isManualPauseInput(inputEvent, currentVideo)', inputContext), false);

let resumeCallback;
let resumeCalls = 0;
let stopped = 0;
const resumeContext = vm.createContext({
  active: true,
  resumePending: true,
  resumeTimer: 0,
  courseGeneration: 0,
  video: { paused: true, ended: false },
  episodeKey: () => 'episode-1',
  MAX_AUTO_RESUMES: 3,
  AUTO_RESUME_WINDOW_MS: 30000,
  resumeEpisode: '',
  resumeWindowStart: 0,
  resumeAttempts: 0,
  window: { setTimeout(callback) { resumeCallback = callback; return 1; } },
  speedWarningVisible: () => false,
  studyNoticeButton: () => null,
  blockedByDialog: () => false,
  tryPlay() { resumeCalls++; },
  holdAutomation() { stopped++; },
  setStatus() {},
  lastAttempt: 'episode-1'
});
vm.runInContext(section('scheduleAutoResume', 'onPause'), resumeContext);
for (let i = 0; i < 3; i++) {
  vm.runInContext('scheduleAutoResume()', resumeContext);
  resumeCallback();
}
assert.equal(resumeCalls, 3);
vm.runInContext('scheduleAutoResume()', resumeContext);
assert.equal(stopped, 1);

function pauseDecision(manualPauseUntil, switchCourse = false) {
  let callback;
  let manualStops = 0;
  let autoSchedules = 0;
  const context = vm.createContext({
    active: true,
    courseGeneration: 0,
    holdKind: '',
    advancing: false,
    video: { paused: true, ended: false },
    pauseCheckPending: false,
    manualPauseUntil,
    resumePending: false,
    window: { setTimeout(fn) { callback = fn; } },
    Date: { now: () => 1000 },
    holdAutomation() { manualStops++; },
    speedWarningVisible: () => false,
    blockedByDialog: () => false,
    studyNoticeButton: () => null,
    scheduleAutoResume() { autoSchedules++; }
  });
  vm.runInContext(section('onPause', 'blockedByDialog'), context);
  vm.runInContext('onPause()', context);
  if (switchCourse) context.courseGeneration++;
  callback();
  return { manualStops, autoSchedules };
}
assert.deepEqual(pauseDecision(1500), { manualStops: 1, autoSchedules: 0 });
assert.deepEqual(pauseDecision(0), { manualStops: 0, autoSchedules: 1 });
assert.deepEqual(pauseDecision(1500, true), { manualStops: 0, autoSchedules: 0 });

let warningClicks = 0;
let warningStops = 0;
const warningTimers = [];
const warningButton = { textContent: '知道了', click() { warningClicks++; } };
const warningContainer = {
  textContent: '系统检测到倍速播放，已自动暂停学习。知道了',
  parentElement: null,
  querySelectorAll() { return [warningButton]; }
};
const warningMessage = {
  textContent: '系统检测到倍速播放，已自动暂停学习。',
  parentElement: warningContainer,
  querySelectorAll() { return []; }
};
const warningContext = vm.createContext({
  documents: () => [{ querySelectorAll() { return [warningMessage]; } }],
  visible: () => true,
  labelOf: element => element.textContent,
  clickTargetFor: element => element,
  speedWarningVisible: () => true,
  speedWarningHandled: false,
  displayCap: true,
  active: true,
  courseGeneration: 0,
  holdKind: '',
  episodeKey: () => 'episode-1',
  speedWarningEpisode: '',
  speedWarningRetries: 0,
  MAX_SPEED_WARNING_RETRIES: 2,
  resumePending: false,
  setStatus() {},
  holdAutomation() { warningStops++; },
  window: { setTimeout(callback) { warningTimers.push(callback); } }
});
vm.runInContext(section('speedWarningButton', 'playableControl'), warningContext);
vm.runInContext('handleSpeedWarning()', warningContext);
assert.equal(warningClicks, 1);
warningTimers.shift()();
assert.equal(warningClicks, 2);
warningTimers.shift()();
assert.equal(warningStops, 1);

const persisted = [];
const toggleContext = vm.createContext({
  active: true,
  holdKind: '',
  advancing: false,
  pendingKey: '',
  pauseCheckPending: false,
  resumePending: false,
  resumeTimer: 0,
  video: null,
  SESSION_ACTIVE: 'active',
  ENABLE_KEY: 'enabled',
  chrome: { storage: { local: { set(value) { persisted.push(value); } } } },
  window: { clearTimeout() {} },
  writeSession() {},
  setStatus() {},
  supported: () => true,
  handleSpeedWarning: () => false,
  dismissStudyNotice: () => false,
  bindVideo() {}
});
vm.runInContext(section('holdAutomation', 'bindVideo'), toggleContext);
vm.runInContext("holdAutomation('等待手动播放', 'manual')", toggleContext);
assert.equal(toggleContext.active, true);
assert.equal(toggleContext.holdKind, 'manual');
assert.equal(persisted.length, 0);
vm.runInContext('pauseAutomation("已暂停")', toggleContext);
assert.equal(toggleContext.active, false);
assert.equal(persisted.at(-1).enabled, false);
vm.runInContext('startAutomation()', toggleContext);
assert.equal(toggleContext.active, true);
assert.equal(toggleContext.holdKind, '');
assert.equal(persisted.at(-1).enabled, true);

let endedChecks = 0;
let candidateReady = false;
const endedContext = vm.createContext({
  active: true,
  advancing: false,
  video: { ended: true },
  document: { hidden: false },
  holdKind: '',
  lastNextProbe: 0,
  Date: { now: () => 60000 },
  findNextCandidate: () => candidateReady ? {} : null,
  onEnded() { endedChecks++; },
  advanceToNext() { endedChecks++; }
});
vm.runInContext(section('checkEndedVideo', 'refresh'), endedContext);
vm.runInContext('checkEndedVideo()', endedContext);
assert.equal(endedChecks, 1);
endedContext.holdKind = 'next';
vm.runInContext('checkEndedVideo()', endedContext);
assert.equal(endedChecks, 1);
candidateReady = true;
endedContext.lastNextProbe = 0;
vm.runInContext('checkEndedVideo()', endedContext);
assert.equal(endedChecks, 2);
endedContext.document.hidden = true;
vm.runInContext('checkEndedVideo()', endedContext);
assert.equal(endedChecks, 3);

const hiddenVideo = { currentSrc: 'lesson.mp4', getBoundingClientRect() { return { width: 0, height: 0 }; } };
const hiddenContext = vm.createContext({
  document: { hidden: true },
  documents: () => [{ querySelectorAll() { return [hiddenVideo]; } }],
  visible: () => false,
  video: hiddenVideo
});
vm.runInContext(section('findVideo', 'mediaKey'), hiddenContext);
assert.equal(vm.runInContext('findVideo()', hiddenContext), hiddenVideo);

console.log('content heuristics: passed');
