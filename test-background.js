const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const listeners = {};
let enabled = true;
let legacyEnabled = false;
let alarm = null;
const messages = [];
const chrome = {
  runtime: { lastError: null, onInstalled: { addListener(fn) { listeners.installed = fn; } },
    onStartup: { addListener(fn) { listeners.startup = fn; } } },
  storage: {
    local: { get(keys, reply) {
      const state = {};
      if (enabled !== undefined) state[keys[0]] = enabled;
      if (legacyEnabled !== undefined) state[keys[1]] = legacyEnabled;
      reply(state);
    } },
    onChanged: { addListener(fn) { listeners.storage = fn; } }
  },
  alarms: {
    get(_name, reply) { reply(alarm); },
    create(name, config) { alarm = { name, ...config }; },
    clear() { alarm = null; },
    onAlarm: { addListener(fn) { listeners.alarm = fn; } }
  },
  tabs: {
    query(_query, reply) { reply([{ id: 1, discarded: false }, { id: 2, discarded: true }, { id: 3, frozen: true }]); },
    sendMessage(id, message, reply) { messages.push({ id, message }); reply(); }
  }
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'background.js'), 'utf8'), { chrome });
listeners.installed();
assert.equal(alarm.periodInMinutes, 0.5);
listeners.alarm(alarm);
assert.equal(messages.length, 1);
assert.equal(messages[0].id, 1);
assert.equal(messages[0].message.type, 'WAKE');
enabled = false;
listeners.storage({ 'smartedu-autoplay:teacher-courses:enabled': { newValue: false } }, 'local');
assert.equal(alarm, null);
enabled = undefined;
legacyEnabled = true;
listeners.storage({ 'smartedu-autoplay:2e001e74-34e1-4b0f-bda9-5350799a91fc:enabled': { newValue: true } }, 'local');
assert.equal(alarm.periodInMinutes, 0.5);

console.log('background wake: passed');
