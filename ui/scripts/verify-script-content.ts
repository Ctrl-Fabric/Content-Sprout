/**
 * Smoke checks for SCRIPT_CONTENT parse / merge / ensure.
 * Run from ui/: npx --yes tsx scripts/verify-script-content.ts
 */
import assert from 'node:assert/strict';
import {
  extractScriptContentBlocks,
  mergeScriptContentWithNext,
  ensureScriptContentMarkers,
  spokenBlocksFromSceneBody,
} from '../src/app/shared/script-scenes';

const body = `[DURATION: 8s]
[SCRIPT_CONTENT]
First line here.
[SCRIPT_CONTENT]
Second line here.
[VISUAL: photo · product]
[SCRIPT_CONTENT]
After visual.`;

const blocks = extractScriptContentBlocks(body);
assert.equal(blocks.length, 3);
assert.equal(blocks[0].text, 'First line here.');
assert.equal(blocks[0].canMergeWithNext, true);
assert.equal(blocks[1].canMergeWithNext, false, 'VISUAL between blocks blocks merge');
assert.equal(blocks[2].canMergeWithNext, false);

const merged = mergeScriptContentWithNext(body, 0);
assert.match(merged, /\[SCRIPT_CONTENT\]\nFirst line here\. Second line here\./);
const afterMerge = extractScriptContentBlocks(merged);
assert.equal(afterMerge.length, 2);
assert.equal(afterMerge[0].text, 'First line here. Second line here.');

const noChange = mergeScriptContentWithNext(body, 1);
assert.equal(noChange, body, 'cannot merge across VISUAL');

const plain = ensureScriptContentMarkers('Hello there.\n\nAnother beat.');
assert.match(plain, /\[SCRIPT_CONTENT\]\nHello there\./);
assert.match(plain, /\[SCRIPT_CONTENT\]\nAnother beat\./);

const fallback = spokenBlocksFromSceneBody('One paragraph.\nTwo paragraph.');
assert.equal(fallback.length, 2);
assert.equal(fallback[0].kind, 'sentence');

console.log('verify-script-content: ok');
