const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8');
const start = source.indexOf('  function isCatalogVideoRow(');
const end = source.indexOf('  function findNextCandidate(', start);
assert.ok(start >= 0 && end > start);

function makeGroup(expanded) {
  const header = { getAttribute(name) { return name === 'aria-expanded' ? String(expanded) : null; } };
  const content = {
    resources: [],
    groups: [],
    querySelectorAll(selector) {
      return selector === '.resource-item' ? this.resources : this.groups;
    }
  };
  return {
    header, content, nextElementSibling: null, parentElement: null,
    matches(selector) { return selector === '.fish-collapse-item'; },
    querySelector(selector) {
      if (selector === ':scope > .fish-collapse-header') return header;
      if (selector === ':scope > .fish-collapse-content') return expanded ? content : null;
      return null;
    }
  };
}

function makeVideoRow(group) {
  return {
    group, nextElementSibling: null,
    matches(selector) { return selector === '.resource-item'; },
    querySelector(selector) { return selector === 'img[src*="video"]' ? {} : null; },
    closest(selector) { return selector === '.fish-collapse-item' ? this.group : null; }
  };
}

const firstGroup = makeGroup(true);
const secondGroup = makeGroup(false);
firstGroup.nextElementSibling = secondGroup;
const current = makeVideoRow(firstGroup);
const sameGroupNext = makeVideoRow(firstGroup);
const doc = { querySelectorAll() { return [current]; } };
const context = vm.createContext({ documents: () => [doc], visible: () => true });
vm.runInContext(source.slice(start, end), context);

let plan = vm.runInContext('findNextByCatalogStructure()', context);
assert.equal(plan.target, secondGroup.header);
assert.equal(plan.expand, true);

current.nextElementSibling = sameGroupNext;
plan = vm.runInContext('findNextByCatalogStructure()', context);
assert.equal(plan.target, sameGroupNext);
assert.equal(plan.expand, false);

current.nextElementSibling = null;
const expandedGroup = makeGroup(true);
const firstVideo = makeVideoRow(expandedGroup);
expandedGroup.content.resources.push(firstVideo);
firstGroup.nextElementSibling = expandedGroup;
plan = vm.runInContext('findNextByCatalogStructure()', context);
assert.equal(plan.target, firstVideo);
assert.equal(plan.expand, false);

const outerGroup = makeGroup(true);
const nextSection = makeGroup(false);
firstGroup.nextElementSibling = null;
firstGroup.parentElement = { closest() { return outerGroup; } };
outerGroup.nextElementSibling = nextSection;
plan = vm.runInContext('findNextByCatalogStructure()', context);
assert.equal(plan.target, nextSection.header);
assert.equal(plan.expand, true);

console.log('catalog structure: passed');
