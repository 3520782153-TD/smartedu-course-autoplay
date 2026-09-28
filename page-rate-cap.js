(() => {
  'use strict';

  const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
  if (!descriptor?.get || !descriptor?.set) return;

  let displayCap = 0;
  Object.defineProperty(HTMLMediaElement.prototype, 'playbackRate', {
    configurable: descriptor.configurable,
    enumerable: descriptor.enumerable,
    get() {
      const actual = descriptor.get.call(this);
      return displayCap === 2 && this instanceof HTMLVideoElement
        ? Math.min(actual, displayCap)
        : actual;
    },
    set(value) {
      descriptor.set.call(this, value);
    }
  });

  window.addEventListener('smartedu-autoplay:set-display-cap', event => {
    displayCap = event.detail === 2 ? 2 : 0;
  });
})();
