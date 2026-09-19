// lib/diff-core.js の mapWithConcurrency() (ページごとのAPI呼び出しを数件ずつ
// 並行実行するためのヘルパー)に対するリグレッションテスト。
// 実行: node test/map-with-concurrency.test.js
//
// 確認する3点:
//  1. 完了順がバラバラでも、結果は入力(ページ)と同じ順序で返ること
//     (表示ページの順序が崩れると実害になるため最重要)
//  2. 同時実行数が指定した上限を超えないこと(PDFを無制限に同時アップロード
//     してしまわないことの保証)
//  3. 実際に直列実行より速くなること(最適化の効果そのものの確認)

'use strict';

const path = require('path');
const assert = require('assert');

global.window = global;
global.Diff = { diffChars: () => [{ value: '' }] }; // mapWithConcurrencyはDiffに依存しないが読み込みのため用意
global.document = { createElement: () => ({ getContext: () => ({}) }) };

require(path.join(__dirname, '..', 'lib', 'diff-core.js'));
const { mapWithConcurrency } = global.PdfDiffCore._internal;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
async function test(label, fn) {
  await fn();
  passed++;
  console.log(`OK: ${label}`);
}

async function main() {
  await test('完了順がバラバラでも結果は入力順を保つ', async () => {
    const items = [
      { ms: 30, value: 'a' },
      { ms: 5, value: 'b' }, // 一番早く終わるが、結果配列では先頭に来てはいけない
      { ms: 15, value: 'c' },
    ];
    const results = await mapWithConcurrency(items, 3, async (item) => {
      await delay(item.ms);
      return item.value;
    });
    assert.deepStrictEqual(results, ['a', 'b', 'c']);
  });

  await test('同時実行数が指定した上限を超えない', async () => {
    const LIMIT = 3;
    let current = 0;
    let peak = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await mapWithConcurrency(items, LIMIT, async () => {
      current++;
      peak = Math.max(peak, current);
      await delay(10);
      current--;
    });
    assert.ok(peak <= LIMIT, `同時実行数の最大値が上限(${LIMIT})を超えました: ${peak}`);
    assert.strictEqual(peak, LIMIT, `10件・上限${LIMIT}なら上限いっぱいまで並行実行されるはず(実際のピーク=${peak})`);
  });

  await test('直列実行より明らかに速い(並列化の効果そのものを確認)', async () => {
    const items = Array.from({ length: 6 }, (_, i) => i);
    const TASK_MS = 40;

    const t0 = Date.now();
    await mapWithConcurrency(items, 1, async () => { await delay(TASK_MS); }); // 直列(concurrency=1)
    const serialMs = Date.now() - t0;

    const t1 = Date.now();
    await mapWithConcurrency(items, 3, async () => { await delay(TASK_MS); }); // 並列(concurrency=3)
    const parallelMs = Date.now() - t1;

    assert.ok(
      parallelMs < serialMs * 0.7,
      `並列実行(${parallelMs}ms)が直列実行(${serialMs}ms)より十分速くなっていません`
    );
  });

  console.log(`\n全${passed}件のテストに合格しました。`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
