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
  deriveScriptContentSections,
  plainScriptContent,
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

const marked = `[SCENE START: Hook]
[DURATION: 8s]
[VISUAL: video · 3s · quick phone scroll]
[SCRIPT_CONTENT]
You keep opening the same apps.
[HELPER: burn on-screen text for 2s]
[SCENE END: Hook]
[SCENE START: Beat 1]
[DURATION: 12s]
[SCRIPT_CONTENT: Here are three habits that stick.]
[PAUSE SCRIPT: 1s]
[ADD ASSET: music · 8s · soft bed]
[SCENE END: Beat 1]`;

const sections = deriveScriptContentSections(marked);
assert.equal(sections.length, 2);
assert.equal(sections[0].sceneName, 'Hook');
assert.deepEqual(sections[0].paragraphs, ['You keep opening the same apps.']);
assert.equal(sections[1].sceneName, 'Beat 1');
assert.deepEqual(sections[1].paragraphs, ['Here are three habits that stick.']);
const spoken = plainScriptContent(marked);
assert.equal(
  spoken,
  'You keep opening the same apps.\n\nHere are three habits that stick.',
);
assert.equal(spoken.includes('['), false);
assert.equal(spoken.includes('VISUAL'), false);
assert.equal(spoken.includes('HELPER'), false);

const unmarked = deriveScriptContentSections('Hello there.\n\nAnother beat.');
assert.equal(unmarked.length, 1);
assert.equal(unmarked[0].sceneName, null);
assert.deepEqual(unmarked[0].paragraphs, ['Hello there.', 'Another beat.']);

console.log('verify-script-content: ok');
