const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeMedia {
  constructor() { this.actualRate = 1; }
}
Object.defineProperty(FakeMedia.prototype, 'playbackRate', {
  configurable: true,
  enumerable: true,
  get() { return this.actualRate; },
  set(value) { this.actualRate = value; }
});
class FakeVideo extends FakeMedia {}
class FakeAudio extends FakeMedia {}

const listeners = new Map();
const page = {
  HTMLMediaElement: FakeMedia,
  HTMLVideoElement: FakeVideo,
  window: {
    addEventListener(name, listener) { listeners.set(name, listener); }
  }
};
const script = fs.readFileSync(path.join(__dirname, 'page-rate-cap.js'), 'utf8');
vm.runInNewContext(script, page);

const video = new FakeVideo();
const audio = new FakeAudio();
video.playbackRate = 16;
audio.playbackRate = 16;
assert.equal(video.playbackRate, 16);

const setCap = listeners.get('smartedu-autoplay:set-display-cap');
assert.equal(typeof setCap, 'function');
setCap({ detail: 2 });
assert.equal(video.playbackRate, 2);
assert.equal(video.actualRate, 16);
assert.equal(audio.playbackRate, 16);

video.playbackRate = 4;
assert.equal(video.actualRate, 4);
assert.equal(video.playbackRate, 2);
setCap({ detail: 0 });
assert.equal(video.playbackRate, 4);
console.log('page-rate-cap: passed');
