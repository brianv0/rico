import test from 'node:test';
import assert from 'node:assert/strict';
import { naturalWidth, frameDoc } from '../public/diagrams.js';

test('naturalWidth reads the outer viewBox width and ignores nested svgs', () => {
  assert.equal(naturalWidth('<svg xmlns="x" viewBox="0 0 433 642"><svg viewBox="0 0 10 10"></svg></svg>'), 433);
  assert.equal(naturalWidth('<svg class="a" width="9" viewBox="-5 -5 200.4 80">'), 201);
  assert.equal(naturalWidth('<svg viewBox="0,0,120,60">'), 120);
  assert.equal(naturalWidth('<svg width="100" height="50">'), 0, 'no viewBox: no cap');
  assert.equal(naturalWidth(''), 0);
});

test('the frame caps a diagram at its natural width instead of stretching it to the frame', () => {
  const doc = frameDoc('<svg viewBox="0 0 433 642"><g/></svg>');
  assert.match(doc, /body>svg\{max-width:min\(100%,433px\)\}/);
  assert.doesNotMatch(frameDoc('<svg width="9">'), /body>svg/);
});
