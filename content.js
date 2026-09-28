(() => {
  'use strict';

  const PREFIX = 'smartedu-autoplay:teacher-courses';
  const LEGACY_PREFIX = 'smartedu-autoplay:2e001e74-34e1-4b0f-bda9-5350799a91fc';
  const SESSION_COURSE = `${PREFIX}:course`;
  const SESSION_ACTIVE = `${PREFIX}:active`;
  const ENABLE_KEY = `${PREFIX}:enabled`;
  const SESSION_SPEED = `${PREFIX}:speed`;
  const SESSION_DISPLAY_CAP = `${PREFIX}:display-cap`;
  const LEGACY_ENABLE_KEY = `${LEGACY_PREFIX}:enabled`;
  const SPEEDS = new Set([0, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16]);
  const NEXT_TEXT = /^(?:播放)?(?:下(?:一|1)(?:节|讲|个|课|集|视频)|下一章节)(?:课|视频|内容)?[\s›>»→]*$/;
  const ROW_SELECTOR = 'li,[role="listitem"],.lesson-item,.resource-item,.chapter-item,.catalog-item,.video-item';
  const ACTIVE_SELECTOR = '[aria-current="true"],[aria-current="page"],.active,.current,.playing,.selected,.is-active,.on';
  const MAX_AUTO_RESUMES = 3;
  const AUTO_RESUME_WINDOW_MS = 30000;
  const MAX_SPEED_WARNING_RETRIES = 2;
  const MAX_GROUP_EXPANDS = 3;

  let active = false;
  let currentCourseId = '';
  let courseGeneration = 0;
  let intentTouched = false;
  let holdKind = '';
  let holdSince = 0;
  let status = '待开始';
  let video = null;
  let nativeRate = 1;
  let speed = Number(readSession(SESSION_SPEED) ?? readSession(`${LEGACY_PREFIX}:speed`)) || 0;
  if (!SPEEDS.has(speed)) speed = 0;
  let displayCap = (readSession(SESSION_DISPLAY_CAP) ?? readSession(`${LEGACY_PREFIX}:display-cap`)) === '1';
  let lastUrl = location.href;
  let advancing = false;
  let pendingKey = '';
  let lastAttempt = '';
  let updateTimer = 0;
  let speedWarningHandled = false;
  let lastNoticeButton = null;
  let lastNoticeClick = 0;
  let noticeFirstSeen = 0;
  let manualPauseUntil = 0;
  let pauseCheckPending = false;
  let resumePending = false;
  let resumeTimer = 0;
  let resumeAttempts = 0;
  let resumeWindowStart = 0;
  let resumeEpisode = '';
  let speedWarningEpisode = '';
  let speedWarningRetries = 0;
  let endedPendingKey = '';
  let lastNextProbe = 0;
  const observedDocuments = new WeakSet();

  function readSession(key) {
    try { return sessionStorage.getItem(key); } catch { return null; }
  }

  function writeSession(key, value) {
    try {
      if (value === null) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, value);
    } catch { /* A disabled storage area only affects reload recovery. */ }
  }

  function disableDisplayCap() {
    if (!displayCap) return;
    displayCap = false;
    writeSession(SESSION_DISPLAY_CAP, null);
    syncDisplayCap();
  }

  function validCourseId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
  }

  function changeCourse(id) {
    if (id === currentCourseId) return;
    currentCourseId = id;
    courseGeneration++;
    if (video) {
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ratechange', onRateChange);
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video = null;
    }
    advancing = false;
    pendingKey = '';
    endedPendingKey = '';
    lastAttempt = '';
    holdKind = '';
    holdSince = 0;
    pauseCheckPending = false;
    resumePending = false;
    resumeAttempts = 0;
    speedWarningHandled = false;
    speedWarningEpisode = '';
    speedWarningRetries = 0;
    lastNoticeButton = null;
    noticeFirstSeen = 0;
    window.clearTimeout(resumeTimer);
    resumeTimer = 0;
    if (active) setStatus(id
      ? '已进入另一门课程，正在查找播放器…'
      : '已离开课程页；连播保持开启，等待进入课程。');
  }

  function supported() {
    if (location.hostname !== 'www.smartedu.cn' || !location.pathname.startsWith('/jiaoshi/')) {
      changeCourse('');
      disableDisplayCap();
      return false;
    }
    const id = new URL(location.href).searchParams.get('courseId');
    if (id && !validCourseId(id)) {
      changeCourse('');
      disableDisplayCap();
      return false;
    }
    if (id) {
      writeSession(SESSION_COURSE, id);
      changeCourse(id);
      return true;
    }
    const remembered = readSession(SESSION_COURSE);
    if (/^\/jiaoshi\/course/i.test(location.pathname) && validCourseId(remembered)) {
      changeCourse(remembered);
      return true;
    }
    changeCourse('');
    disableDisplayCap();
    return false;
  }

  function visible(element) {
    if (!element || !element.isConnected) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  }

  function documents(root = document, found = []) {
    found.push(root);
    for (const frame of root.querySelectorAll('iframe')) {
      try {
        if ((visible(frame) || root.hidden) && frame.contentDocument) documents(frame.contentDocument, found);
      } catch { /* Cross-origin frames cannot be inspected. */ }
    }
    return found;
  }

  function syncDisplayCap() {
    for (const doc of documents()) {
      const view = doc.defaultView;
      if (!view) continue;
      view.dispatchEvent(new view.CustomEvent('smartedu-autoplay:set-display-cap', {
        detail: displayCap ? 2 : 0
      }));
    }
  }

  function findVideo() {
    const candidates = documents().flatMap(doc => [...doc.querySelectorAll('video')]);
    const shown = candidates.filter(visible).sort((a, b) => {
      const area = node => {
        const rect = node.getBoundingClientRect();
        return rect.width * rect.height;
      };
      return area(b) - area(a);
    });
    if (shown.length) return shown[0];
    if (document.hidden) return candidates.find(item => item === video) ||
      candidates.find(item => item.currentSrc || item.src) || null;
    return null;
  }

  function mediaKey(currentVideo = video) {
    if (!currentVideo) return location.href;
    return `${location.href}|${currentVideo.currentSrc || currentVideo.src || ''}`;
  }

  function episodeKey() {
    const selection = ordinalSelection();
    const title = selection ? `${selection.current.base}|${selection.current.ordinal}` : '';
    return `${mediaKey()}|${title}`;
  }

  function timeText(currentVideo) {
    if (!currentVideo || !Number.isFinite(currentVideo.duration)) return '';
    const minutes = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
    return ` (${minutes(currentVideo.currentTime)} / ${minutes(currentVideo.duration)})`;
  }

  function rateText() {
    return speed > 0 && video ? `，实际 ${video.playbackRate}×` : '';
  }

  function setStatus(message) {
    status = message;
  }

  function holdAutomation(message, kind) {
    holdKind = kind;
    holdSince = Date.now();
    advancing = false;
    pendingKey = '';
    pauseCheckPending = false;
    resumePending = false;
    window.clearTimeout(resumeTimer);
    resumeTimer = 0;
    setStatus(`连播已开启；${message}`);
  }

  function pauseAutomation(message, pauseMedia = false, persist = true) {
    active = false;
    holdKind = '';
    holdSince = 0;
    advancing = false;
    pendingKey = '';
    pauseCheckPending = false;
    resumePending = false;
    window.clearTimeout(resumeTimer);
    resumeTimer = 0;
    writeSession(SESSION_ACTIVE, null);
    if (persist) {
      intentTouched = true;
      chrome.storage.local.set({ [ENABLE_KEY]: false });
    }
    if (pauseMedia && video && !video.paused) video.pause();
    setStatus(message);
  }

  function startAutomation(persist = true) {
    active = true;
    holdKind = '';
    holdSince = 0;
    advancing = false;
    lastAttempt = '';
    pauseCheckPending = false;
    resumePending = false;
    resumeAttempts = 0;
    resumeEpisode = '';
    speedWarningEpisode = '';
    speedWarningRetries = 0;
    manualPauseUntil = 0;
    window.clearTimeout(resumeTimer);
    resumeTimer = 0;
    writeSession(SESSION_ACTIVE, '1');
    if (persist) {
      intentTouched = true;
      chrome.storage.local.set({ [ENABLE_KEY]: true });
    }
    if (!supported()) return;
    setStatus('连播已开启，正在查找播放器…');
    if (handleSpeedWarning()) return;
    if (dismissStudyNotice()) scheduleRefresh();
    else bindVideo();
  }

  function bindVideo() {
    const current = findVideo();
    if (!current) {
      if (active && !advancing) setStatus('正在等待视频播放器。请先打开一节视频。');
      return;
    }
    if (current !== video) {
      const previousKey = episodeKey();
      if (video) {
        video.removeEventListener('ended', onEnded);
        video.removeEventListener('play', onPlay);
        video.removeEventListener('pause', onPause);
        video.removeEventListener('ratechange', onRateChange);
        video.removeEventListener('loadedmetadata', onLoadedMetadata);
      }
      video = current;
      if (episodeKey() !== previousKey) {
        holdKind = '';
        holdSince = 0;
        endedPendingKey = '';
      }
      nativeRate = video.playbackRate;
      lastAttempt = '';
      pauseCheckPending = false;
      resumePending = false;
      resumeAttempts = 0;
      resumeEpisode = '';
      speedWarningEpisode = '';
      speedWarningRetries = 0;
      manualPauseUntil = 0;
      window.clearTimeout(resumeTimer);
      resumeTimer = 0;
      observeManualPause(video.ownerDocument);
      video.addEventListener('ended', onEnded);
      video.addEventListener('play', onPlay);
      video.addEventListener('pause', onPause);
      video.addEventListener('ratechange', onRateChange);
      video.addEventListener('loadedmetadata', onLoadedMetadata);
      applySpeed();
    }
    if (advancing && episodeKey() !== pendingKey) {
      advancing = false;
      pendingKey = '';
    }
    if (active && !holdKind && !advancing && video.paused && !video.ended) {
      if (resumePending) scheduleAutoResume();
      else if (!pauseCheckPending) tryPlay();
    }
  }

  function tryPlay() {
    if (!active || holdKind || !video || !video.paused || video.ended) return;
    const key = episodeKey();
    if (key === lastAttempt) return;
    lastAttempt = key;
    setStatus('正在启动视频播放…');
    const generation = courseGeneration;
    const playingVideo = video;
    playingVideo.play().then(() => {
      if (generation !== courseGeneration || video !== playingVideo) return;
      if (active) setStatus(`正在播放${timeText(video)}${rateText()}`);
    }).catch(() => {
      if (generation !== courseGeneration || video !== playingVideo) return;
      if (!active) return;
      if (resumePending) {
        setStatus('自动继续播放未成功，稍后重试…');
        scheduleAutoResume();
      } else {
        setStatus('浏览器阻止了自动播放，请在页面上手动点一次播放。');
      }
    });
  }

  function onPlay() {
    lastAttempt = '';
    holdKind = '';
    holdSince = 0;
    manualPauseUntil = 0;
    pauseCheckPending = false;
    resumePending = false;
    window.clearTimeout(resumeTimer);
    resumeTimer = 0;
    if (advancing && episodeKey() !== pendingKey) {
      advancing = false;
      pendingKey = '';
    }
    if (speed > 0 && Math.abs(video.playbackRate - speed) > 0.01) applySpeed();
    if (active) setStatus(`正在播放${timeText(video)}${rateText()}`);
  }

  function applySpeed() {
    if (!video || speed === 0) return;
    try {
      video.playbackRate = speed;
      if (Math.abs(video.playbackRate - speed) > 0.01) {
        setStatus(`播放器只接受 ${video.playbackRate}×，未达到所选 ${speed}×。`);
      }
    } catch {
      setStatus(`播放器不接受 ${speed}×。`);
    }
  }

  function onLoadedMetadata() {
    applySpeed();
  }

  function onRateChange() {
    if (!video) return;
    if (speed === 0) nativeRate = video.playbackRate;
    else if (Math.abs(video.playbackRate - speed) > 0.01) {
      setStatus(`平台或浏览器将速度设为 ${video.playbackRate}×；扩展所选 ${speed}× 未保持。`);
    }
  }

  function setSpeed(value) {
    const next = Number(value);
    if (!SPEEDS.has(next)) return false;
    if (speed === 0 && next > 0 && video) nativeRate = video.playbackRate;
    speed = next;
    writeSession(SESSION_SPEED, String(speed));
    if (!video) {
      setStatus(speed ? `已选 ${speed}×；检测到视频后会尝试应用。` : '已恢复跟随平台倍速。');
      return true;
    }
    if (speed === 0) {
      try { video.playbackRate = nativeRate; } catch { /* Keep the browser's current rate. */ }
      setStatus(`已恢复跟随平台倍速（${video.playbackRate}×）。`);
    } else {
      applySpeed();
      if (Math.abs(video.playbackRate - speed) <= 0.01) setStatus(`已设扩展倍速 ${speed}×。`);
    }
    return true;
  }

  function setDisplayCap(value) {
    if (typeof value !== 'boolean') return false;
    if (displayCap !== value) speedWarningHandled = false;
    displayCap = value;
    writeSession(SESSION_DISPLAY_CAP, displayCap ? '1' : null);
    syncDisplayCap();
    setStatus(displayCap
      ? '测试模式已开启：页面读取 video.playbackRate 时最多得到 2×；实际速度见下方诊断。'
      : '测试模式已关闭；页面可读取实际播放速度。');
    handleSpeedWarning();
    return true;
  }

  function isManualPauseInput(event, currentVideo) {
    if (!currentVideo) return false;
    if (event.type === 'keydown') {
      if (event.target?.closest?.('input,textarea,[contenteditable="true"]')) return false;
      return [' ', 'k', 'K', 'MediaPlayPause'].includes(event.key);
    }
    const target = event.target;
    if (target?.nodeType !== 1) return false;
    if (target === currentVideo || currentVideo.contains(target)) return true;
    const control = target.closest('button,[role="button"],[aria-label],[title]');
    const label = `${control?.getAttribute('aria-label') || ''} ${control?.getAttribute('title') || ''} ${labelOf(control)}`;
    if (/暂停|pause/i.test(label)) return true;
    const box = currentVideo.getBoundingClientRect();
    return event.clientX >= box.left && event.clientX <= box.left + 100 &&
      event.clientY >= box.bottom - 55 && event.clientY <= box.bottom + 70;
  }

  function observeManualPause(doc) {
    if (!doc || observedDocuments.has(doc)) return;
    observedDocuments.add(doc);
    const mark = event => {
      if (active && video?.ownerDocument === doc && isManualPauseInput(event, video)) {
        manualPauseUntil = Date.now() + 1500;
      }
    };
    doc.addEventListener('pointerdown', mark, true);
    doc.addEventListener('keydown', mark, true);
  }

  function scheduleAutoResume() {
    if (!active || !resumePending || resumeTimer || !video || !video.paused || video.ended) return;
    const key = episodeKey();
    const now = Date.now();
    if (key !== resumeEpisode || now - resumeWindowStart > AUTO_RESUME_WINDOW_MS) {
      resumeEpisode = key;
      resumeWindowStart = now;
      resumeAttempts = 0;
    }
    if (resumeAttempts >= MAX_AUTO_RESUMES) {
      holdAutomation('连续自动暂停，已达到 3 次重试上限；请检查播放器提示。', 'resume');
      return;
    }
    const generation = courseGeneration;
    resumeTimer = window.setTimeout(() => {
      if (generation !== courseGeneration) return;
      resumeTimer = 0;
      if (!active || !resumePending || !video || !video.paused || video.ended) return;
      if (speedWarningVisible()) {
        handleSpeedWarning();
        return;
      }
      if (studyNoticeButton()) {
        dismissStudyNotice();
        scheduleRefresh();
        return;
      }
      if (blockedByDialog()) {
        holdAutomation('页面需要答题或确认，请处理后继续。', 'dialog');
        return;
      }
      resumeAttempts++;
      lastAttempt = '';
      setStatus(`非手动暂停，正在继续播放（第 ${resumeAttempts}/${MAX_AUTO_RESUMES} 次）…`);
      tryPlay();
    }, 650);
  }

  function onPause() {
    if (!active || holdKind || advancing || !video || video.ended) return;
    const pausedVideo = video;
    const generation = courseGeneration;
    pauseCheckPending = true;
    window.setTimeout(() => {
      if (generation !== courseGeneration) return;
      pauseCheckPending = false;
      if (!active || advancing || video !== pausedVideo || !video.paused || video.ended) return;
      if (Date.now() <= manualPauseUntil) {
        holdAutomation('检测到手动暂停；在页面点击播放，或点扩展“开始 / 继续”可恢复。', 'manual');
        return;
      }
      if (speedWarningVisible()) {
        handleSpeedWarning();
        return;
      }
      if (blockedByDialog()) {
        holdAutomation('页面需要答题或确认，请处理后继续。', 'dialog');
        return;
      }
      resumePending = true;
      if (studyNoticeButton()) {
        dismissStudyNotice();
        scheduleRefresh();
      } else {
        scheduleAutoResume();
      }
    }, 250);
  }

  function blockedByDialog() {
    const dialogs = documents().flatMap(doc => [...doc.querySelectorAll('[role="dialog"],.ant-modal,.el-dialog,.modal')]);
    return dialogs.some(el => visible(el) && /测试|答题|验证|确认|考试|测验|倍速播放|暂停学习/.test(el.textContent || ''));
  }

  function studyNoticeButton() {
    const phrase = '须学习完课程的视频才可获得该课程视频的学时';
    for (const doc of documents()) {
      const messages = [...doc.querySelectorAll('div,p,span')]
        .filter(el => visible(el) && (el.textContent || '').includes(phrase) &&
          (el.textContent || '').trim().length < 240)
        .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
      for (const message of messages) {
        let container = message;
        for (let depth = 0; depth < 6 && container; depth++, container = container.parentElement) {
          if ((container.textContent || '').length > 500) break;
          const buttons = [...container.querySelectorAll('button,a,[role="button"],div,span')]
            .filter(el => visible(el) && labelOf(el) === '我知道了')
            .sort((a, b) => {
              const area = el => {
                const box = el.getBoundingClientRect();
                return box.width * box.height;
              };
              return area(a) - area(b);
            });
          if (buttons.length) return clickTargetFor(buttons[0]);
        }
      }
    }
    return null;
  }

  function dismissStudyNotice() {
    const button = studyNoticeButton();
    if (!button) {
      noticeFirstSeen = 0;
      lastNoticeButton = null;
      return false;
    }
    const now = Date.now();
    if (!noticeFirstSeen) noticeFirstSeen = now;
    if (now - noticeFirstSeen > 5000) {
      if (active) holdAutomation('学时提示未能自动关闭，请手动处理。', 'notice');
      else setStatus('学时提示未能自动关闭，请手动处理。');
      return true;
    }
    if (button !== lastNoticeButton || now - lastNoticeClick > 3000) {
      lastNoticeButton = button;
      lastNoticeClick = now;
      button.click();
      lastAttempt = '';
      setStatus('已关闭学时提示，继续检查播放器…');
    }
    return true;
  }

  function speedWarningVisible() {
    return documents().some(doc => [...doc.querySelectorAll('[role="dialog"],.ant-modal,.el-dialog,.modal,div,p,span')]
      .some(el => {
        const message = (el.textContent || '').trim();
        return message.length < 220 && message.includes('系统检测到倍速播放') &&
          message.includes('自动暂停学习') && visible(el);
      }));
  }

  function speedWarningButton() {
    for (const doc of documents()) {
      const messages = [...doc.querySelectorAll('div,p,span')]
        .filter(el => visible(el) && (el.textContent || '').includes('系统检测到倍速播放') &&
          (el.textContent || '').includes('自动暂停学习') &&
          (el.textContent || '').trim().length < 240)
        .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
      for (const message of messages) {
        let container = message;
        for (let depth = 0; depth < 6 && container; depth++, container = container.parentElement) {
          if ((container.textContent || '').length > 500) break;
          const buttons = [...container.querySelectorAll('button,a,[role="button"],div,span')]
            .filter(el => visible(el) && ['知道了', '我知道了'].includes(labelOf(el)));
          if (buttons.length) return clickTargetFor(buttons[buttons.length - 1]);
        }
      }
    }
    return null;
  }

  function handleSpeedWarning() {
    if (!speedWarningVisible()) {
      speedWarningHandled = false;
      return false;
    }
    if (speedWarningHandled) return true;
    if (holdKind === 'speed') return true;
    speedWarningHandled = true;
    if (displayCap) {
      if (!active) {
        setStatus('平台检测到倍速并暂停学习；当前测试显示平台仍有其他检测信号。');
        return true;
      }
      const key = episodeKey();
      if (key !== speedWarningEpisode) {
        speedWarningEpisode = key;
        speedWarningRetries = 0;
      }
      if (speedWarningRetries >= MAX_SPEED_WARNING_RETRIES) {
        holdAutomation('平台反复检测到倍速，已停止自动重试；学习状态请以平台显示为准。', 'speed');
        return true;
      }
      const button = speedWarningButton();
      if (!button) {
        holdAutomation('平台检测到倍速，但未找到可确认的提示按钮。', 'speed');
        return true;
      }
      speedWarningRetries++;
      resumePending = true;
      setStatus(`平台检测到倍速，已确认提示并尝试继续（第 ${speedWarningRetries}/${MAX_SPEED_WARNING_RETRIES} 次）…`);
      try { button.click(); }
      catch {
        holdAutomation('倍速提示按钮点击失败，请手动处理。', 'speed');
        return true;
      }
      const generation = courseGeneration;
      window.setTimeout(() => {
        if (generation !== courseGeneration) return;
        if (!active) return;
        speedWarningHandled = false;
        if (speedWarningVisible()) handleSpeedWarning();
        else scheduleAutoResume();
      }, 700);
      return true;
    }
    const current = video || findVideo();
    if (speed > 0) setSpeed(0);
    if (current) {
      try { current.playbackRate = 1; } catch { /* The site controls this player. */ }
      if (!current.paused) current.pause();
    }
    nativeRate = 1;
    if (active) holdAutomation('平台已暂停学习。扩展倍速已关闭，请点“知道了”后按平台允许的速度继续。', 'speed');
    else setStatus('平台已暂停学习。扩展倍速已关闭，请点“知道了”后按平台允许的速度继续。');
    return true;
  }

  function playableControl(element) {
    if (!visible(element) || element.closest('header,nav,footer')) return false;
    if (element.matches('[disabled],[aria-disabled="true"]')) return false;
    return true;
  }

  function labelOf(element) {
    return (element?.innerText || element?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 90);
  }

  function bestClickTarget(row) {
    const inner = [...row.querySelectorAll('a,button,[role="button"]')]
      .find(el => playableControl(el) && labelOf(el).length >= 4);
    return inner || row;
  }

  function clickTargetFor(element) {
    const title = labelOf(element);
    let target = element;
    let ancestor = element;
    for (let depth = 0; depth < 6 && ancestor; depth++, ancestor = ancestor.parentElement) {
      const box = ancestor.getBoundingClientRect();
      const text = labelOf(ancestor);
      const clickable = ancestor.matches('a,button,[role="button"]') ||
        getComputedStyle(ancestor).cursor === 'pointer';
      if (clickable && box.height >= 25 && box.height <= 115 &&
          text.includes(title) && text.length <= title.length + 8) target = ancestor;
    }
    return target;
  }

  function rgbOf(value) {
    const match = value.match(/^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    return match ? match.slice(1, 4).map(Number) : null;
  }

  function blueText(element) {
    const rgb = rgbOf(getComputedStyle(element).color);
    return rgb && rgb[2] >= 150 && rgb[2] - rgb[0] >= 70 && rgb[2] - rgb[1] >= 45;
  }

  function ordinalNumber(value) {
    if (/^\d+$/.test(value)) return Number(value);
    const digits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (value === '十') return 10;
    if (value.startsWith('十')) return 10 + (digits[value[1]] || 0);
    if (value.endsWith('十')) return (digits[value[0]] || 0) * 10;
    if (value.includes('十')) return (digits[value[0]] || 0) * 10 + (digits[value[2]] || 0);
    return digits[value] || null;
  }

  function ordinalTitle(value) {
    const parenthesized = value.match(/^(.{5,80}?)\s*[（(]([一二三四五六七八九十\d]+)[）)]$/);
    if (parenthesized) {
      const ordinal = ordinalNumber(parenthesized[2]);
      return ordinal === null ? null : { base: parenthesized[1].trim(), ordinal };
    }
    const numberedLesson = value.match(/^第([一二三四五六七八九十\d]+)(讲|节|课|集)[：:、.．\s-]+.{2,80}$/);
    if (numberedLesson) {
      const ordinal = ordinalNumber(numberedLesson[1]);
      return ordinal === null ? null : { base: `序列:${numberedLesson[2]}`, ordinal };
    }
    const dotted = value.match(/^(\d{1,3})[.．](\d{1,3})\s*.{2,80}$/);
    return dotted ? { base: `章节:${dotted[1]}`, ordinal: Number(dotted[2]) } : null;
  }

  function ordinalSelection() {
    const candidates = documents().flatMap(doc => {
      const heading = findCatalogHeading(doc);
      const left = heading ? heading.getBoundingClientRect().left - 110 : innerWidth * 0.45;
      return [...doc.querySelectorAll('a,button,span,div,li,p')]
      .filter(el => visible(el) && el.getBoundingClientRect().left >= left)
      .map(el => ({ element: el, title: ordinalTitle(labelOf(el)) }))
      .filter(item => item.title);
    });
    const ranked = candidates.map(item => {
      let score = 0;
      let ancestor = item.element;
      for (let depth = 0; depth < 5 && ancestor; depth++, ancestor = ancestor.parentElement) {
        if (blueText(ancestor)) score = Math.max(score, 10 - depth);
        if (blueBackground(ancestor)) score = Math.max(score, 12 - depth);
        if (ancestor.matches(ACTIVE_SELECTOR)) score = Math.max(score, 4 - depth);
      }
      return { ...item, score };
    }).filter(item => item.score >= 6);
    if (ranked.length === 0) return null;
    const bestScore = Math.max(...ranked.map(item => item.score));
    const bestTitles = new Map();
    for (const item of ranked.filter(item => item.score === bestScore)) {
      bestTitles.set(`${item.title.base}|${item.title.ordinal}`, item.title);
    }
    if (bestTitles.size !== 1) return null;
    const current = [...bestTitles.values()][0];
    const currentElements = ranked.filter(item => item.score === bestScore &&
      item.title.base === current.base && item.title.ordinal === current.ordinal);
    const area = item => {
      const box = item.element.getBoundingClientRect();
      return box.width * box.height;
    };
    currentElements.sort((a, b) => area(a) - area(b));
    const currentElement = currentElements[0].element;
    let next = candidates.filter(item =>
      item.title.base === current.base && item.title.ordinal === current.ordinal + 1
    );
    if (next.length === 0) {
      next = candidates.filter(item =>
        item.element.ownerDocument === currentElement.ownerDocument &&
        (item.title.base !== current.base || item.title.ordinal !== current.ordinal) &&
        (currentElement.compareDocumentPosition(item.element) & Node.DOCUMENT_POSITION_FOLLOWING)
      ).sort((a, b) => {
        if (a.element === b.element) return 0;
        return a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
      if (next.length === 0) return { current, currentElement, next: null };
      const first = next[0];
      const betweenHeadings = [...currentElement.ownerDocument.querySelectorAll('a,button,span,div,li,p')]
        .filter(el => visible(el) && blueText(el) &&
          (currentElement.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) &&
          (el.compareDocumentPosition(first.element) & Node.DOCUMENT_POSITION_FOLLOWING))
        .map(el => labelOf(el))
        .filter(text => text.length >= 8 && text.length <= 80 && !ordinalTitle(text));
      if (betweenHeadings.length && betweenHeadings[0] !== first.title.base) {
        return { current, currentElement, next: null };
      }
      next = next.filter(item => item.title.base === first.title.base &&
        item.title.ordinal === first.title.ordinal);
    }
    next.sort((a, b) => area(a) - area(b));
    return { current, currentElement, next: clickTargetFor(next[0].element) };
  }

  function findNextByOrdinal() {
    return ordinalSelection()?.next || null;
  }

  function findNextGroupHeading() {
    const selection = ordinalSelection();
    if (!selection || selection.next) return null;
    const catalog = findCatalogHeading(selection.currentElement.ownerDocument);
    if (!catalog) return null;
    const catalogLeft = catalog.getBoundingClientRect().left - 110;
    let ancestor = selection.currentElement;
    for (let depth = 0; depth < 6 && ancestor; depth++, ancestor = ancestor.parentElement) {
      let next = ancestor.nextElementSibling;
      while (next && !visible(next)) next = next.nextElementSibling;
      if (!next || next.getBoundingClientRect().left < catalogLeft) continue;
      const title = labelOf(next);
      if (title.length < 8 || title.length > 80 || ordinalTitle(title) ||
          title === selection.current.base) continue;
      const matching = [next, ...next.querySelectorAll('a,button,[role="button"],span,div')]
        .filter(el => visible(el) && labelOf(el) === title);
      const blue = matching.some(blueText);
      const target = matching.find(el => el.matches('a,button,[role="button"]') ||
        getComputedStyle(el).cursor === 'pointer');
      if (blue && target && playableControl(target)) return target;
    }
    return null;
  }

  function findNextControl() {
    const matches = documents().flatMap(doc => [...doc.querySelectorAll('button,a,[role="button"]')])
      .filter(playableControl)
      .filter(el => NEXT_TEXT.test((el.textContent || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, '')));
    return matches.length === 1 ? matches[0] : null;
  }

  function hasLessonCue(row) {
    let element = row;
    for (let depth = 0; depth < 2 && element; depth++, element = element.parentElement) {
      const hint = `${element.className || ''} ${element.getAttribute?.('data-type') || ''}`;
      if (/lesson|video|resource|play/i.test(hint)) return true;
      if (element.querySelector?.('[class*="video"],[class*="play"],[data-type*="video"]')) return true;
    }
    return false;
  }

  function plausibleNextLesson(current, next) {
    const title = labelOf(bestClickTarget(next));
    if (title.length < 4 || title.length > 120 ||
        /^(?:目录|课程简介|课程介绍|课程评价|评论|讨论|测验|考试)$/.test(title)) return false;
    if (ordinalTitle(title)) return true;
    const before = current.getBoundingClientRect();
    const after = next.getBoundingClientRect();
    return Math.abs(after.left - before.left) <= 45 &&
      after.width >= before.width * 0.7 &&
      Math.abs(after.height - before.height) <= 45 &&
      hasLessonCue(current) && hasLessonCue(next);
  }

  function findNextListItem() {
    const highlighted = findNextHighlightedItem();
    if (highlighted) return highlighted;
    const matches = documents().flatMap(doc => [...doc.querySelectorAll(ACTIVE_SELECTOR)]);
    const choices = [];
    for (const selected of matches) {
      const row = selected.closest(ROW_SELECTOR);
      if (!row || !visible(row)) continue;
      let next = row.nextElementSibling;
      while (next && !visible(next)) next = next.nextElementSibling;
      if (!next || !next.matches(ROW_SELECTOR)) continue;
      const control = bestClickTarget(next);
      if (playableControl(control) && plausibleNextLesson(row, next)) choices.push(control);
    }
    const unique = [...new Set(choices)];
    return unique.length === 1 ? unique[0] : null;
  }

  function blueBackground(element) {
    const rgb = rgbOf(getComputedStyle(element).backgroundColor);
    if (!rgb) return false;
    const [red, green, blue] = rgb;
    return red >= 170 && green >= 170 && blue - red >= 9 && blue - green >= 4;
  }

  function findCatalogHeading(doc) {
    const headings = [...doc.querySelectorAll('h1,h2,h3,h4,div,span')]
      .filter(el => visible(el) && labelOf(el) === '目录');
    return headings.sort((a, b) => {
      const area = el => {
        const box = el.getBoundingClientRect();
        return box.width * box.height;
      };
      return area(a) - area(b);
    })[0] || null;
  }

  function findNextHighlightedItem() {
    for (const doc of documents()) {
      const heading = findCatalogHeading(doc);
      if (!heading) continue;
      const headingBox = heading.getBoundingClientRect();
      const rows = [...doc.querySelectorAll('*')].filter(el => {
        if (!visible(el) || !blueBackground(el)) return false;
        const box = el.getBoundingClientRect();
        const title = labelOf(el);
        return box.left >= headingBox.left - 110 &&
          box.top >= headingBox.bottom + 5 &&
          box.width >= 180 && box.height >= 35 && box.height <= 115 &&
          title.length >= 5 && title.length <= 90;
      });
      if (rows.length === 0) continue;
      rows.sort((a, b) => {
        const area = el => {
          const box = el.getBoundingClientRect();
          return box.width * box.height;
        };
        return area(b) - area(a);
      });
      const selected = rows[0];
      const selectedBox = selected.getBoundingClientRect();
      let ancestor = selected;
      for (let depth = 0; depth < 5 && ancestor; depth++, ancestor = ancestor.parentElement) {
        let next = ancestor.nextElementSibling;
        while (next && !visible(next)) next = next.nextElementSibling;
        if (!next) continue;
        const box = next.getBoundingClientRect();
        const similarRow = Math.abs(box.left - selectedBox.left) <= 45 &&
          box.width >= selectedBox.width * 0.75 &&
          box.height >= 35 && box.height <= 115 &&
          box.top >= selectedBox.bottom - 8 && box.top <= selectedBox.bottom + 120;
        if (!similarRow || !labelOf(next)) continue;
        const control = bestClickTarget(next);
        if (playableControl(control) && plausibleNextLesson(selected, next)) return control;
      }
    }
    return null;
  }

  function isCatalogVideoRow(row) {
    return row?.matches?.('.resource-item') && !!row.querySelector('img[src*="video"]');
  }

  function firstCatalogPlan(group) {
    const header = group.querySelector(':scope > .fish-collapse-header');
    if (!header || !visible(header)) return null;
    if (header.getAttribute('aria-expanded') === 'false') {
      return { target: header, expand: true };
    }
    const content = group.querySelector(':scope > .fish-collapse-content');
    if (!content) return null;
    const ownVideo = [...content.querySelectorAll('.resource-item')]
      .find(row => row.closest('.fish-collapse-item') === group &&
        visible(row) && isCatalogVideoRow(row));
    if (ownVideo) return { target: ownVideo, expand: false };
    const childGroups = [...content.querySelectorAll('.fish-collapse-item')]
      .filter(item => item.parentElement?.closest('.fish-collapse-item') === group);
    for (const child of childGroups) {
      const plan = firstCatalogPlan(child);
      if (plan) return plan;
    }
    return null;
  }

  function findNextByCatalogStructure() {
    for (const doc of documents()) {
      const selected = [...doc.querySelectorAll('.resource-item.resource-item-active')]
        .filter(row => visible(row) && isCatalogVideoRow(row));
      if (selected.length !== 1) continue;
      const current = selected[0];
      let next = current.nextElementSibling;
      while (next?.matches('.resource-item')) {
        if (visible(next) && isCatalogVideoRow(next)) {
          return { target: next, expand: false };
        }
        next = next.nextElementSibling;
      }
      let group = current.closest('.fish-collapse-item');
      while (group) {
        let sibling = group.nextElementSibling;
        while (sibling) {
          if (sibling.matches('.fish-collapse-item')) {
            return firstCatalogPlan(sibling);
          }
          sibling = sibling.nextElementSibling;
        }
        group = group.parentElement?.closest('.fish-collapse-item');
      }
    }
    return null;
  }

  function findNextCandidate() {
    const catalogPlan = findNextByCatalogStructure();
    if (catalogPlan) return catalogPlan;
    const lesson = findNextControl() || findNextByOrdinal();
    if (lesson) return { target: lesson, expand: false };
    const heading = findNextGroupHeading();
    if (heading) return { target: heading, expand: true };
    const fallback = findNextListItem();
    return fallback ? { target: fallback, expand: false } : null;
  }

  function advanceToNext(manual = false, noticeAttempts = 0, expandAttempts = 0) {
    const generation = courseGeneration;
    if (advancing) {
      setStatus('正在切换，请稍候…');
      return;
    }
    if (dismissStudyNotice()) {
      if (noticeAttempts >= 3) {
        if (active) holdAutomation('学时提示未关闭，请手动处理后继续。', 'notice');
        else setStatus('学时提示未关闭，请手动处理后重试。');
        return;
      }
      window.setTimeout(() => {
        if (generation === courseGeneration) advanceToNext(manual, noticeAttempts + 1, expandAttempts);
      }, 700);
      return;
    }
    if (blockedByDialog()) {
      if (active) holdAutomation('页面需要答题或确认，请处理后继续。', 'dialog');
      else setStatus('页面需要答题或确认，请先处理。');
      return;
    }
    const plan = findNextCandidate();
    if (!plan) {
      if (active) holdAutomation('没有找到明确的下一节；目录更新后会再次检查。', 'next');
      else setStatus('没有找到明确的下一节。');
      return;
    }
    const next = plan.target;
    if (plan.expand) {
      if (expandAttempts >= MAX_GROUP_EXPANDS) {
        if (active) holdAutomation('已尝试展开多个目录层级，但仍未找到首节。', 'next');
        else setStatus('已尝试展开多个目录层级，但仍未找到首节。');
        return;
      }
      advancing = true;
      pendingKey = episodeKey();
      setStatus(`正在展开下一组：${labelOf(next)}`);
      try { next.click(); }
      catch {
        advancing = false;
        pendingKey = '';
        if (active) holdAutomation('下一组标题点击失败。', 'next');
        else setStatus('下一组标题点击失败。');
        return;
      }
      window.setTimeout(() => {
        if (generation !== courseGeneration) return;
        advancing = false;
        pendingKey = '';
        if (!supported()) return;
        advanceToNext(manual, noticeAttempts, expandAttempts + 1);
      }, 700);
      return;
    }
    const before = episodeKey();
    const title = labelOf(next);
    advancing = true;
    pendingKey = before;
    setStatus(`已点击：${title}；正在确认切换…`);
    try {
      next.click();
    } catch {
      advancing = false;
      pendingKey = '';
      if (active) holdAutomation('目录项点击失败。', 'next');
      else setStatus('目录项点击失败。');
      return;
    }
    window.setTimeout(() => {
      if (generation !== courseGeneration) return;
      if (!supported()) return;
      const changed = episodeKey() !== before;
      advancing = false;
      pendingKey = '';
      if (!changed) {
        if (active) holdAutomation('点击目录项后未检测到切换，请手动检查页面。', 'next');
        else setStatus('点击目录项后未检测到切换，请手动检查页面。');
        return;
      }
      bindVideo();
      if (manual && !active) setStatus(`已检测到切换：${title}。`);
      else if (active && video && video.paused) tryPlay();
      else if (active) setStatus(`已切换：${title}${rateText()}`);
    }, 7000);
  }

  function onEnded() {
    if (!active || holdKind || advancing) return;
    const generation = courseGeneration;
    const finishedKey = episodeKey();
    if (endedPendingKey === finishedKey) return;
    endedPendingKey = finishedKey;
    setStatus('本节播放完毕，正在检查下一节…');
    window.setTimeout(() => {
      if (generation !== courseGeneration) return;
      endedPendingKey = '';
      if (!active || holdKind || advancing) return;
      if (episodeKey() !== finishedKey || (video && !video.ended)) {
        bindVideo();
        return;
      }
      advanceToNext(false);
    }, 1200);
  }

  function checkEndedVideo() {
    if (!active || advancing || !video?.ended) return;
    if (holdKind === 'next') {
      const now = Date.now();
      if (now - lastNextProbe < 30000) return;
      lastNextProbe = now;
      if (findNextCandidate()) holdKind = '';
    }
    if (!holdKind) {
      if (document.hidden) {
        endedPendingKey = '';
        advanceToNext(false);
      } else onEnded();
    }
  }

  function refresh() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      advancing = false;
      pendingKey = '';
      lastAttempt = '';
      holdKind = '';
      holdSince = 0;
      endedPendingKey = '';
    }
    if (!supported()) return;
    if (holdKind === 'dialog' && !blockedByDialog()) holdKind = '';
    if (holdKind === 'notice' && !studyNoticeButton()) holdKind = '';
    syncDisplayCap();
    if (handleSpeedWarning()) return;
    if (dismissStudyNotice()) {
      if (Date.now() - noticeFirstSeen <= 5000) scheduleRefresh();
      return;
    }
    if (holdKind === 'resume' && Date.now() - holdSince >= AUTO_RESUME_WINDOW_MS) {
      holdKind = '';
      resumePending = true;
      resumeAttempts = 0;
    }
    bindVideo();
    checkEndedVideo();
  }

  function scheduleRefresh() {
    window.clearTimeout(updateTimer);
    updateTimer = window.setTimeout(refresh, 250);
  }

  function diagnostics() {
    const attempts = [
      resumeAttempts ? `自动继续 ${resumeAttempts} 次` : '',
      speedWarningRetries ? `倍速提示 ${speedWarningRetries} 次` : ''
    ].filter(Boolean).join('；');
    const suffix = attempts ? `；${attempts}` : '';
    if (!video || !video.isConnected) return `播放器：未检测到${suffix}。`;
    return `播放器：已检测${timeText(video)}；${video.ended ? '已播完' : video.paused ? '已暂停' : '播放中'}；当前 ${video.playbackRate}×${suffix}。`;
  }

  function replyState(reply, extra = {}) {
    reply({ supported: true, courseId: currentCourseId, active, holdKind,
      status, diagnostics: diagnostics(), speed, displayCap, ...extra });
  }

  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    const ok = supported();
    if (!ok) {
      reply({ supported: false, status: '请打开教师发展中心的课程页；网址通常包含 courseId。' });
      return;
    }
    switch (message.type) {
      case 'START':
        startAutomation();
        break;
      case 'PAUSE':
        pauseAutomation('已暂停。', true);
        break;
      case 'STOP':
        pauseAutomation('已停止。', true);
        break;
      case 'STATUS':
        refresh();
        break;
      case 'WAKE':
        refresh();
        break;
      case 'PREVIEW': {
        const plan = findNextCandidate();
        replyState(reply, { preview: plan
          ? plan.expand ? `需先展开下一组：${labelOf(plan.target)}` : `预计下一节：${labelOf(plan.target)}`
          : '未识别到下一节。' });
        return;
      }
      case 'TEST_NEXT':
        advanceToNext(true);
        break;
      case 'SET_SPEED':
        if (Number(message.speed) > 0 && handleSpeedWarning()) {
          replyState(reply);
          return;
        }
        if (!setSpeed(message.speed)) {
          replyState(reply, { status: '无效的倍速选项。' });
          return;
        }
        break;
      case 'SET_DISPLAY_CAP':
        if (!setDisplayCap(message.enabled)) {
          replyState(reply, { status: '无效的测试模式选项。' });
          return;
        }
        break;
      default:
        replyState(reply, { status: '未知操作。' });
        return;
    }
    replyState(reply);
  });

  new MutationObserver(scheduleRefresh).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style']
  });
  document.addEventListener('visibilitychange', refresh);
  window.setInterval(() => {
    if (location.href !== lastUrl || active || speed > 0 || displayCap) refresh();
  }, 1500);
  if (readSession(SESSION_SPEED) === null && speed > 0) writeSession(SESSION_SPEED, String(speed));
  if (readSession(SESSION_DISPLAY_CAP) === null && displayCap) writeSession(SESSION_DISPLAY_CAP, '1');
  chrome.storage.local.get([ENABLE_KEY, LEGACY_ENABLE_KEY], data => {
    if (intentTouched) return;
    const enabled = data[ENABLE_KEY] === true ||
      (data[ENABLE_KEY] === undefined && (data[LEGACY_ENABLE_KEY] === true ||
        readSession(SESSION_ACTIVE) === '1' || readSession(`${LEGACY_PREFIX}:active`) === '1'));
    if (enabled) startAutomation(data[ENABLE_KEY] === undefined);
    else pauseAutomation('待开始', false, false);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[ENABLE_KEY]) return;
    const enabled = changes[ENABLE_KEY].newValue === true;
    if (enabled && !active) startAutomation(false);
    else if (!enabled && active) pauseAutomation('已暂停。', true, false);
  });
  refresh();
})();
