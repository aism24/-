// lib/diff-core.js の alignPages() (新旧PDFのページ挿入/削除自動検出)に対する
// リグレッションテスト。実行: node test/align-pages.test.js
//
// npmパッケージには依存しない(このフォルダはVercelにビルド無しでそのまま
// デプロイされるため、package.json/node_modulesを追加するとビルド構成に
// 影響しかねない)。本番で使うjsdiff(Diff.diffChars)の代わりに、同じ用途
// (2文字列間のLCS長を求める)を満たす最小限のスタブをこの場で用意し、
// lib/diff-core.js 自体は一切書き換えずに読み込んで検証する。

'use strict';

const path = require('path');
const assert = require('assert');

// ---- Diff.diffChars の最小スタブ(LCS長だけをtextSimilarity用に返す) ----
// textSimilarity()は「addedでもremovedでもないchunkのvalue.length合計」しか
// 見ないため、LCS長ぶんの文字を1個のchunkにまとめて返せば本物のjsdiffと
// 同じ類似度計算結果になる。
function lcsLength(a, b) {
  const n = a.length, m = b.length;
  const dp = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    let prevDiag = 0;
    for (let j = 1; j <= m; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prevDiag + 1 : Math.max(dp[j], dp[j - 1]);
      prevDiag = temp;
    }
  }
  return dp[m];
}

global.window = global;
global.Diff = {
  diffChars(a, b) {
    return [{ value: 'x'.repeat(lcsLength(a, b)) }];
  },
};
global.document = { createElement: () => ({ getContext: () => ({}) }) };

require(path.join(__dirname, '..', 'lib', 'diff-core.js'));
const { alignPages } = global.PdfDiffCore._internal;

// ---- テスト用シグネチャ生成 ----

// テキスト系(表/文章モードや、文字が十分あるページ)を想定した signature。
// textSimilarity()は text.length>=20 のときに使われる経路。
function textSig(text) {
  return { text, thumb: null };
}

// 図面モード(ページにほとんど文字が無い場合)を想定した signature。
// pageSimilarity()は text.length<20 のとき、8x8程度の縮小画像の明暗
// パターン(ここではsin波で模した疑似パターン)で類似度を判定する。
function imageSig(baseSeed, editSeed) {
  const W = 8, H = 8;
  const gray = new Float32Array(W * H);
  for (let i = 0; i < gray.length; i++) {
    const base = 128 + 80 * Math.sin((i + baseSeed) * 0.7);
    const edit = editSeed ? 15 * Math.sin((i + editSeed) * 3.1) : 0;
    gray[i] = Math.max(0, Math.min(255, base + edit));
  }
  return { text: '', thumb: { w: W, h: H, gray } };
}

function expectPairs(actual, expected, label) {
  assert.strictEqual(actual.length, expected.length, `${label}: 出力ページ数が一致しません`);
  actual.forEach((p, i) => {
    const e = expected[i];
    assert.strictEqual(p.type, e.type, `${label}: out${i + 1}のtypeが違います(実際=${p.type}, 期待=${e.type})`);
    assert.strictEqual(p.oldIdx, e.oldIdx, `${label}: out${i + 1}のoldIdxが違います`);
    assert.strictEqual(p.newIdx, e.newIdx, `${label}: out${i + 1}のnewIdxが違います`);
  });
}

let passed = 0;
function test(label, fn) {
  fn();
  passed++;
  console.log(`OK: ${label}`);
}

// 20文字超にして textSimilarity 経路を確実に通す
const rep = (s) => s.repeat(3);

// ============================================================
// シナリオ1: 変更なし(挿入・削除なし、全ページ編集のみ)
// ============================================================
test('変更なし: 旧3枚/新3枚、挿入削除なし', () => {
  const oldSigs = [textSig(rep('第1条 甲乙間の契約。旧A')), textSig(rep('第2条 契約期間1年。旧B')), textSig(rep('第3条 秘密保持。旧C'))];
  const newSigs = [textSig(rep('第1条 甲乙間の契約。新A')), textSig(rep('第2条 契約期間1年。新B')), textSig(rep('第3条 秘密保持。新C'))];
  const pairs = alignPages(oldSigs, newSigs);
  expectPairs(pairs, [
    { type: 'pair', oldIdx: 0, newIdx: 0 },
    { type: 'pair', oldIdx: 1, newIdx: 1 },
    { type: 'pair', oldIdx: 2, newIdx: 2 },
  ], '変更なし');
});

// ============================================================
// シナリオ2: ユーザー提示のページ挿入シナリオ
// 旧3枚(各ページ編集あり)、新2ページ目に無関係な新規ページを挿入して新4枚に。
// 期待: 旧1:新1 / なし:新2(挿入) / 旧2:新3 / 旧3:新4
// ============================================================
test('ページ挿入: 旧3枚/新4枚、新2ページ目に無関係ページを挿入(ユーザー提示シナリオ)', () => {
  const old1 = rep('第1条 本契約は甲乙間で締結する。旧版テキストA。');
  const old2 = rep('第2条 契約期間は1年とする。旧版テキストB。');
  const old3 = rep('第3条 秘密保持義務を負う。旧版テキストC。');
  const new1 = rep('第1条 本契約は甲乙間で締結する。新版テキストA。');
  const new2Inserted = rep('第1条の2 新設。今回新たに追加された全く別内容の条項。');
  const new3 = rep('第2条 契約期間は2年とする。新版テキストB。');
  const new4 = rep('第3条 秘密保持義務を負う。新版テキストC(追記)。');

  const pairs = alignPages(
    [textSig(old1), textSig(old2), textSig(old3)],
    [textSig(new1), textSig(new2Inserted), textSig(new3), textSig(new4)]
  );
  expectPairs(pairs, [
    { type: 'pair', oldIdx: 0, newIdx: 0 },
    { type: 'insert', oldIdx: null, newIdx: 1 },
    { type: 'pair', oldIdx: 1, newIdx: 2 },
    { type: 'pair', oldIdx: 2, newIdx: 3 },
  ], 'ページ挿入');
});

// ============================================================
// シナリオ3: ページ削除(旧4枚 -> 新3枚、旧のあるページが削除される)
// ============================================================
test('ページ削除: 旧4枚/新3枚、旧3ページ目が削除', () => {
  const old1 = rep('第1条 本契約は甲乙間で締結する。旧版テキストA。');
  const old2 = rep('第2条 契約期間は1年とする。旧版テキストB。');
  const old3 = rep('第3条 秘密保持義務を負う。旧版テキストC。');
  const old4 = rep('第4条 損害賠償について定める。旧版テキストD。');
  const new1 = rep('第1条 本契約は甲乙間で締結する。新版テキストA。');
  const new2 = rep('第2条 契約期間は2年とする。新版テキストB。');
  const new3 = rep('第4条 損害賠償について定める。新版テキストD(修正)。');

  const pairs = alignPages(
    [textSig(old1), textSig(old2), textSig(old3), textSig(old4)],
    [textSig(new1), textSig(new2), textSig(new3)]
  );
  expectPairs(pairs, [
    { type: 'pair', oldIdx: 0, newIdx: 0 },
    { type: 'pair', oldIdx: 1, newIdx: 1 },
    { type: 'delete', oldIdx: 2, newIdx: null },
    { type: 'pair', oldIdx: 3, newIdx: 2 },
  ], 'ページ削除');
});

// ============================================================
// (既知の限界)挿入と削除が同時に起きるケースは、現状のGAP_PENALTY方式では
// 「無関係な旧ページ」と「無関係な新ページ」が誤って1組のpairとして対応
// 付けられてしまうことがある(2026-09-19時点で確認・報告済み、未修正)。
// 誤った挙動を正として固定してしまわないよう、ここでは意図的にテスト化
// していない。詳細はREADME.mdの「既知の制約」を参照。
// ============================================================
// シナリオ5: 図面モード相当(文字がほぼ無く、サムネイル類似度で判定する経路)
// 旧3枚(各ページ微修正あり)、新2ページ目に無関係な図面を挿入して新4枚に。
// ============================================================
test('図面モード(サムネイル類似度): 旧3枚/新4枚、新2ページ目に無関係な図面を挿入', () => {
  const pairs = alignPages(
    [imageSig(1), imageSig(2), imageSig(3)],
    [imageSig(1, 101), imageSig(999), imageSig(2, 102), imageSig(3, 103)]
  );
  expectPairs(pairs, [
    { type: 'pair', oldIdx: 0, newIdx: 0 },
    { type: 'insert', oldIdx: null, newIdx: 1 },
    { type: 'pair', oldIdx: 1, newIdx: 2 },
    { type: 'pair', oldIdx: 2, newIdx: 3 },
  ], '図面モード挿入');
});

console.log(`\n全${passed}件のテストに合格しました。`);
