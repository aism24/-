/* =====================================================================
 * 日報全期間集計 - フロントエンド
 *
 * GAS側の新規JSON API(doPost)を叩いて実データを取得・Excel生成する。
 * 既存の「日報アプリより集計」(GAS Webアプリ、google.script.run方式)とは
 * 別のデプロイ(GAS_API_URL)を使う。既存デプロイ・既存の動作には一切影響しない。
 * ===================================================================== */

// デプロイ済みGAS Webアプリの新規デプロイURL(/exec で終わるURL)。
// 既存のGAS Webアプリ(google.script.run方式)のデプロイとは別物。
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbyiocXgXi_YEMUUq5BJPe7CUi2V-LJIBvLwceextYV-82hEArRKRaHQ5peVj5oMfTsW/exec";

// GAS APIへのPOSTリクエスト共通処理。
// Content-Type は "text/plain" にすることでCORSプリフライト(OPTIONS)を回避している
// (hot-heart等、他アプリと同じ方式。GASはOPTIONSに対応していないため)。
async function apiPost(action, params) {
  const res = await fetch(GAS_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: action, params: params || {} }),
  });
  if (!res.ok) throw new Error('サーバーエラー（HTTP ' + res.status + '）');
  const json = await res.json();
  if (json.status !== 'success') throw new Error(json.message || 'データの取得に失敗しました');
  return json.data;
}

/* ===== 会社ロゴ ===== */
const LOGO_DATA_URI = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0NjQgNTE0IiB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIj4KICA8IS0tIOato+WFiSAobWFzYW1peikgTG9nbyBNYXJrIC0tPgogIDxwYXRoIGQ9Ik0gMzk4IDE1OCBMIDM5NiAxNTkgTCAzOTIgMTYxIEwgMzg3IDE2NSBMIDM4MCAxNjggTCAzNzMgMTczIEwgMzcxIDE3MyBMIDM2OCAxNzUgTCAzNzAgMTc5IEwgMzczIDE5MCBMIDM3NCAxOTUgTCAzNzUgMjAxIEwgMzc2IDIwNyBMIDM3NyAyMjAgTCAzNzYgMjQwIEwgMzc1IDI0NiBMIDM3NCAyNTIgTCAzNzMgMjU3IEwgMzcxIDI2NCBMIDM2NyAyNzYgTCAzNjMgMjg1IEwgMzYyIDI4NyBMIDM2MCAyODkgTCAzNjAgMjkxIEwgMzU3IDI5NiBMIDM0OSAzMDggTCAzNDYgMzEyIEwgMzQwIDMxOSBMIDMyOCAzMzEgTCAzMjIgMzM2IEwgMzE4IDMzOSBMIDMxNCAzNDIgTCAzMTEgMzQ0IEwgMzA2IDM0NyBMIDMwMSAzNTAgTCAyOTMgMzU0IEwgMjg2IDM1NyBMIDI4MSAzNTkgTCAyNzggMzYwIEwgMjcxIDM2MSBMIDI2OCAzNjMgTCAyNjMgMzY0IEwgMjU3IDM2NSBMIDI1MiAzNjYgTCAyNDkgMzY1IEwgMjUwIDMxMSBMIDI1MyAzMTAgTCAyNTcgMzEwIEwgMjYxIDMwOSBMIDI2OSAzMDYgTCAyNzEgMzA1IEwgMjczIDMwMyBMIDI3NSAzMDMgTCAyODAgMzAwIEwgMjg2IDI5NSBMIDI4OCAyOTUgTCAyOTMgMjg5IEwgMjk0IDI4OCBMIDI5NyAyODcgTCAzMDUgMjc4IEwgMzA3IDI3NSBMIDMwNyAyNzMgTCAzMDQgMjcxIEwgMjk0IDI2NiBMIDI5MCAyNjMgTCAyODggMjYzIEwgMjg2IDI2NSBMIDI3NiAyNzYgTCAyNzIgMjc5IEwgMjY5IDI4MSBMIDI2NCAyODQgTCAyNTcgMjg3IEwgMjU0IDI4OCBMIDI1MSAyODkgTCAyNDEgMjg5IEwgMjQwIDI5MSBMIDIyOCAyOTAgTCAyMTggMjg5IEwgMjE0IDI4OCBMIDIxMSAyODcgTCAyMDkgMjg1IEwgMTk5IDI4MSBMIDE5NSAyNzggTCAxOTEgMjc1IEwgMTkwIDI3NCBMIDE4OCAyNzIgTCAxODcgMjcxIEwgMTgxIDI2MyBMIDE3OCAyNjUgTCAxNjEgMjc0IEwgMTYyIDI3NiBMIDE2NSAyODAgTCAxNzQgMjg4IEwgMTc1IDI4OSBMIDE3NSAyOTAgTCAxNzcgMjkyIEwgMTgxIDI5NSBMIDE4NSAyOTggTCAxODggMzAwIEwgMTkzIDMwMyBMIDE5NSAzMDQgTCAxOTcgMzA0IEwgMTk5IDMwNiBMIDIwMiAzMDcgTCAyMTEgMzEwIEwgMjE1IDMxMSBMIDIyMCAzMTIgTCAyMjAgNDAwIEwgMjMxIDQwMSBMIDIzMyA0MDEgTCAyMzggNDAxIEwgMjU0IDQwMCBMIDI2NiAzOTggTCAyNzIgMzk3IEwgMjgzIDM5NCBMIDI5NSAzOTAgTCAzMDAgMzg4IEwgMzA3IDM4NSBMIDMwOSAzODMgTCAzMjEgMzc4IEwgMzI2IDM3NSBMIDMyOSAzNzMgTCAzMzIgMzcwIEwgMzM1IDM2OSBMIDMzOSAzNjYgTCAzNDQgMzYxIEwgMzQ3IDM2MCBMIDM0OCAzNTkgTCAzNDggMzU4IEwgMzQ5IDM1NyBMIDM2OCAzMzkgTCAzNzIgMzM0IEwgMzc3IDMyOCBMIDM3OSAzMjUgTCAzODYgMzE0IEwgMzg5IDMwOSBMIDM5MiAzMDMgTCAzOTIgMzAxIEwgMzk0IDI5OSBMIDM5NSAyOTQgTCAzOTggMjkwIEwgNDAxIDI4MiBMIDQwNCAyNzIgTCA0MDcgMjYxIEwgNDA4IDI1NCBMIDQwOSAyNDggTCA0MTAgMjQxIEwgNDEwIDIwNiBMIDQwOSAxOTkgTCA0MDggMTkzIEwgNDA3IDE4NyBMIDQwNCAxNzQgTCA0MDIgMTcxIEwgNDAyIDE2OCBMIDQwMSAxNjUgTCAzOTkgMTYyIFogTSA4OSAxMjQgTCA4NyAxMjYgTCA4NSAxMjkgTCA4MyAxMzIgTCA3NyAxNDMgTCA3NyAxNDUgTCA3NSAxNDcgTCA3MCAxNTkgTCA2OCAxNjQgTCA2NSAxNzQgTCA2MiAxODUgTCA2MiAxOTEgTCA1OSAyMDIgTCA1OCAyMTUgTCA1OSAyMTggTCA1OCAyMzIgTCA1OSAyNDQgTCA2MSAyNTYgTCA2MiAyNjIgTCA2NCAyNjYgTCA2NCAyNzAgTCA2NyAyODAgTCA2OCAyODMgTCA3MSAyOTEgTCA3MyAyOTMgTCA3NSAzMDAgTCA3NyAzMDIgTCA3NyAzMDQgTCA4MyAzMTUgTCA4NyAzMjEgTCA5MiAzMjcgTCA5MyAzMzAgTCA5NiAzMzQgTCA5OCAzMzYgTCAxMDIgMzQxIEwgMTA1IDM0MyBMIDExOCAzNTcgTCAxMjQgMzYyIEwgMTM1IDM3MCBMIDEzOCAzNzIgTCAxNDEgMzc0IEwgMTQ2IDM3NyBMIDE1MyAzODEgTCAxNTUgMzgyIEwgMTU3IDM4MiBMIDE1OSAzODQgTCAxNjEgMzg1IEwgMTY4IDM4OCBMIDE3NiAzOTEgTCAxODkgMzk1IEwgMTkzIDM5NSBMIDE5NyAzOTcgTCAyMDIgMzk4IEwgMjA4IDM5OSBMIDIwOSAzNjQgTCAyMDYgMzY0IEwgMjA1IDM2MyBMIDIwMSAzNjMgTCAxOTEgMzYwIEwgMTg3IDM1OSBMIDE4NSAzNTcgTCAxODAgMzU2IEwgMTczIDM1MyBMIDE3MSAzNTEgTCAxNjkgMzUxIEwgMTYyIDM0NyBMIDE1MyAzNDEgTCAxNDkgMzM4IEwgMTQ0IDMzNCBMIDEzNyAzMjggTCAxMzYgMzI3IEwgMTM1IDMyNiBMIDEzMyAzMjQgTCAxMjQgMzE0IEwgMTIwIDMwOSBMIDExNyAzMDUgTCAxMTUgMzAyIEwgMTEyIDI5NyBMIDEwOCAyOTAgTCAxMDcgMjg4IEwgMTAxIDI3NCBMIDk4IDI2NiBMIDk4IDI2MiBMIDk1IDI1NSBMIDk0IDI0OSBMIDkzIDI0NCBMIDkyIDIzMyBMIDkyIDIxNCBMIDkzIDIwNCBMIDk0IDE5OCBMIDk1IDE5MiBMIDk4IDE4MiBMIDEwMSAxNzMgTCAxMDUgMTY2IEwgMTA3IDE2NyBMIDExMSAxNjkgTCAxMTggMTczIEwgMTI1IDE3OCBMIDEzMiAxODEgTCAxMzkgMTg1IEwgMTQ5IDE5MSBMIDE1MSAxOTQgTCAxNDkgMTk3IEwgMTQ4IDIwMiBMIDE0NyAyMDYgTCAxNDYgMjExIEwgMTQ2IDIzNiBMIDE0OCAyNDEgTCAxNDggMjQ2IEwgMTUyIDI1OCBMIDE1NCAyNjIgTCAxNTYgMjYyIEwgMTYwIDI1OSBMIDE2OCAyNTUgTCAxNzMgMjUyIEwgMTczIDI0OSBMIDE3MSAyNDYgTCAxNjkgMjM5IEwgMTY4IDIzNCBMIDE2OCAyMTMgTCAxNzAgMjA1IEwgMTcxIDIwMSBMIDE3NCAxOTQgTCAxNzcgMTg5IEwgMTc5IDE4NiBMIDE4MSAxODMgTCAxODYgMTc3IEwgMTg4IDE3NSBMIDE5NCAxNzAgTCAxOTcgMTY4IEwgMjAwIDE2NiBMIDIwNSAxNjMgTCAyMDcgMTYyIEwgMjEyIDE2MCBMIDIxNSAxNTkgTCAyMjIgMTU3IEwgMjI4IDE1NiBMIDIyNyAxMzUgTCAyMjAgMTM1IEwgMjExIDEzNyBMIDIwMiAxNDAgTCAxOTkgMTQxIEwgMTkzIDE0NCBMIDE4OCAxNDcgTCAxODUgMTQ5IEwgMTgyIDE1MSBMIDE3OCAxNTQgTCAxNjUgMTY3IEwgMTYzIDE2NiBMIDE2MSAxNjQgTCAxNTUgMTYxIEwgMTM5IDE1MSBMIDEzMiAxNDcgTCAxMjggMTQ2IEwgMTIzIDE0MiBMIDExMSAxMzUgTCAxMDQgMTMxIEwgOTUgMTI2IEwgOTEgMTI0IFogTSAyMTkgNDYgTCAyMTAgNDcgTCAxOTkgNDkgTCAxOTQgNTAgTCAxODMgNTMgTCAxODAgNTUgTCAxNzcgNTUgTCAxNzQgNTYgTCAxNjYgNTkgTCAxNjQgNjEgTCAxNDggNjggTCAxNDMgNzEgTCAxMzcgNzUgTCAxMzQgNzcgTCAxMzIgNzkgTCAxMzIgODAgTCAxMzEgODEgTCAxMjcgODMgTCAxMjIgODcgTCAxMTYgOTIgTCAxMDcgMTAyIEwgMTA1IDEwMyBMIDEwNCAxMDQgTCA5OSAxMTEgTCA5NiAxMTMgTCA5NyAxMTUgTCAxMDAgMTE2IEwgMTEyIDEyNCBMIDEyMSAxMjkgTCAxMjMgMTI5IEwgMTI1IDEzMSBMIDEyNyAxMzEgTCAxNDMgMTE0IEwgMTQ5IDEwOSBMIDE1NiAxMDQgTCAxNjEgMTAxIEwgMTY2IDk4IEwgMTcwIDk2IEwgMTc2IDkzIEwgMTgzIDkwIEwgMTg4IDg4IEwgMTk4IDg1IEwgMjAyIDg0IEwgMjExIDgyIEwgMjE5IDgxIEwgMjUwIDgxIEwgMjU4IDgyIEwgMjY3IDg0IEwgMjcxIDg1IEwgMjc4IDg3IEwgMjgxIDg4IEwgMjg5IDkxIEwgMjkxIDkzIEwgMzAzIDk4IEwgMzEwIDEwMiBMIDMxMyAxMDQgTCAzMTYgMTA2IEwgMzIwIDEwOSBMIDMyNSAxMTMgTCAzNDMgMTMxIEwgMzQ3IDEzNiBMIDM0OCAxNDEgTCAzNDYgMTQxIEwgMzQxIDE0NCBMIDMyOSAxNTEgTCAzMTcgMTU5IEwgMzEyIDE2MiBMIDMwOCAxNjMgTCAzMDUgMTY1IEwgMzAzIDE2NyBMIDMwMSAxNjUgTCAyOTIgMTU1IEwgMjg3IDE1MSBMIDI3OSAxNDYgTCAyNzUgMTQ0IEwgMjY5IDE0MSBMIDI2MSAxMzggTCAyNTcgMTM3IEwgMjQ5IDEzNSBMIDI0MSAxMzUgTCAyNDEgMTU3IEwgMjQ3IDE1NyBMIDI1NCAxNTkgTCAyNTcgMTYwIEwgMjY0IDE2MyBMIDI2OSAxNjYgTCAyNzIgMTY4IEwgMjc2IDE3MSBMIDI4OCAxODMgTCAyOTAgMTg2IEwgMjkzIDE5MSBMIDI5NiAxOTcgTCAyOTggMjAyIEwgMjk5IDIwNiBMIDMwMCAyMTAgTCAzMDEgMjE1IEwgMzAxIDIzMSBMIDMwMCAyMzcgTCAyOTggMjQ0IEwgMjk2IDI0NyBMIDI5NSAyNTAgTCAyOTggMjUzIEwgMzAzIDI1NiBMIDMxMiAyNjAgTCAzMTUgMjYyIEwgMzE3IDI1NyBMIDMyMCAyNDkgTCAzMjEgMjQ0IEwgMzIxIDIzOSBMIDMyMyAyMzYgTCAzMjMgMjEzIEwgMzIxIDIwMiBMIDMyMCAxOTggTCAzMTggMTk1IEwgMzE5IDE5MSBMIDMyMiAxOTAgTCAzMzEgMTg0IEwgMzQ0IDE3NiBMIDM1MSAxNzIgTCAzNTggMTY4IEwgMzYwIDE2OCBMIDM2NSAxNjUgTCAzODkgMTUwIEwgMzkwIDE1MCBMIDM5MiAxNDkgTCAzOTMgMTQ2IEwgMzg5IDE0MCBMIDM4OSAxMzggTCAzODggMTM2IEwgMzgzIDEyOCBMIDM3NyAxMTkgTCAzNzQgMTE1IEwgMzcwIDExMCBMIDM2NSAxMDQgTCAzNTUgOTQgTCAzNTQgOTMgTCAzNDggODggTCAzNDcgODggTCAzNDEgODMgTCAzMzggNzkgTCAzMjYgNzEgTCAzMjEgNjggTCAzMDcgNjEgTCAyOTUgNTYgTCAyODYgNTMgTCAyNzUgNTAgTCAyNzAgNDkgTCAyNjUgNDkgTCAyNjAgNDcgTCAyNDkgNDYgWiIgZmlsbD0iI0U3NDE1NSIgZmlsbC1ydWxlPSJldmVub2RkIiAvPgogIAogIDwhLS0gbWFzYW1peiBUZXh0IC0tPgogIDxwYXRoIGQ9Ik0gMzYzIDQzOCBMIDM2NCA0NTAgTCAzNzAgNDUwIEwgMzc2IDQ1MCBMIDM4NSA0NTAgTCAzOTEgNDUwIEwgMzg4IDQ1MiBMIDM4MSA0NTUgTCAzNzQgNDYwIEwgMzY1IDQ2NCBMIDM2MyA0NjYgTCAzNjQgNDg1IEwgNDIxIDQ4NSBMIDQyMSA0NzMgTCAzODkgNDcyIEwgMzkyIDQ3MCBMIDM5NyA0NjcgTCA0MDEgNDY2IEwgNDA2IDQ2MyBMIDQxNSA0NTcgTCA0MTggNDU2IEwgNDIwIDQ1NSBMIDQyMSA0MzcgWiBNIDI5OCA0MzYgTCAyOTggNDg1IEwgMzE2IDQ4NSBMIDMxNyA0NDggTCAzMjAgNDQ5IEwgMzIwIDQ4NSBMIDMzOCA0ODQgTCAzMzkgNDQ4IEwgMzQzIDQ0OCBMIDM0OSA0NTMgTCAzNDIgNDU1IEwgMzQyIDQ3MSBMIDM0MyA0ODUgTCAzNjAgNDg1IEwgMzYwIDQ1NCBMIDM1MyA0NTMgTCAzNTggNDQ5IEwgMzU5IDQ0NyBMIDM1OSA0NDIgTCAzNTcgNDM4IEwgMzU2IDQzOCBMIDM1NCA0MzYgTCAzNDggNDM2IEwgMzQ2IDQzNyBMIDM0NCA0MzkgTCAzNDMgNDQxIEwgMzQyIDQzNiBaIE0gMjM2IDQzNiBMIDIzNiA0NTAgTCAyNDUgNDUwIEwgMjQ4IDQ0OSBMIDI1MSA0NTAgTCAyNjAgNDUwIEwgMjc5IDQ1MCBMIDI3OCA0NTUgTCAyNDEgNDU1IEwgMjM5IDQ1NiBMIDIzNyA0NTggTCAyMzYgNDYwIEwgMjM2IDQ4NSBMIDI5NSA0ODUgTCAyOTUgNDQzIEwgMjk0IDQ0MSBMIDI5MyA0MzkgTCAyOTIgNDM4IEwgMjkxIDQzOCBMIDI4OSA0MzYgWiBNIDI1MyA0NjcgTCAyNzkgNDY4IEwgMjc4IDQ3MiBMIDI1MyA0NzMgWiBNIDE3OCA0MzYgTCAxNzUgNDM3IEwgMTcyIDQ0MCBMIDE3MSA0NDcgTCAxNzEgNDQ5IEwgMTcxIDQ1NCBMIDE3MyA0NTggTCAxNzUgNDU4IEwgMTc3IDQ2MCBMIDE3OSA0NjEgTCAxODEgNDYxIEwgMTgzIDQ2MyBMIDE5NCA0NjcgTCAxOTYgNDY5IEwgMjAzIDQ3MiBMIDE3MiA0NzMgTCAxNzEgNDc1IEwgMTcyIDQ4NSBMIDIyOCA0ODUgTCAyMzAgNDg0IEwgMjMxIDQ4MyBMIDIzMiA0ODEgTCAyMzIgNDY2IEwgMjI5IDQ2NCBMIDIyNCA0NjIgTCAyMTggNDYwIEwgMjE2IDQ1OCBMIDIxMCA0NTUgTCAyMDMgNDUzIEwgMjAxIDQ1MSBMIDE5OCA0NTAgTCAyMzIgNDQ5IEwgMjMyIDQzNiBaIE0gMTEwIDQzNiBMIDEwOSA0NTAgTCAxNTIgNDUxIEwgMTUxIDQ1NSBMIDExNyA0NTUgTCAxMTQgNDU2IEwgMTEyIDQ1NyBMIDExMCA0NTkgTCAxMDkgNDYxIEwgMTA5IDQ4NSBMIDE2OCA0ODUgTCAxNjggNDQyIEwgMTY3IDQ0MCBMIDE2NSA0MzggTCAxNjMgNDM3IEwgMTYwIDQzNiBMIDEzMyA0MzcgTCAxMTUgNDM3IFogTSAxMjcgNDY3IEwgMTUyIDQ2OCBMIDE1MSA0NzMgTCAxMjYgNDcyIFogTSA0NCA0MzYgTCA0MyA0NzQgTCA0NSA0ODYgTCA2MyA0ODUgTCA2NCA0NDggTCA2OCA0NDkgTCA2OCA0ODYgTCA3MyA0ODYgTCA4NCA0ODUgTCA4NSA0NDggTCA4OSA0NDkgTCA4OSA0ODUgTCAxMDYgNDg1IEwgMTA2IDQ0NSBMIDEwNSA0NDEgTCAxMDQgNDM5IEwgMTAzIDQzOCBMIDEwMSA0MzcgTCA5OSA0MzYgWiIgZmlsbD0iIzAwMDAwMCIgZmlsbC1ydWxlPSJldmVub2RkIiAvPgo8L3N2Zz4=";
document.querySelectorAll('[data-logo]').forEach(img => img.src = LOGO_DATA_URI);

/* ===================== サーバーから取得するデータ(初期値は空) ===================== */
let MASTER = { constructions: [], workItems: [], operators: [], earliestArchiveYear: null };
let ALL_ROWS = []; // getAllDailyReportRows(複数ファイル横断・重複排除済み)の結果 + _date付与
let CALENDAR_MAP = {}; // 'yyyy/MM/dd' -> '出勤'|'休日'
let ABSENTEEISM = []; // {operatorNo, from, to, type}

// MASTER取得後に組み立てるルックアップマップ
let WORK_DEPT = {};   // workCode -> '工場'|'設計管理'
let WORK_META = {};   // workCode -> 名称
let CONSTRUCTION_LABEL = {}; // constructionId -> 工事名
let CONSTRUCTION_NO = {};    // constructionId -> 工事No(並び替え用)

const FACTORY_ORDER = ['本社', '夢前', '鳥取'];

function buildMasterDependentMaps_() {
  WORK_DEPT = {}; WORK_META = {}; CONSTRUCTION_LABEL = {}; CONSTRUCTION_NO = {};
  MASTER.workItems.forEach(w => { WORK_DEPT[w.code] = w.dept; WORK_META[w.code] = w.name; });
  MASTER.constructions.forEach(c => { CONSTRUCTION_LABEL[c.id] = c.name; CONSTRUCTION_NO[c.id] = c.no; });
}

/* ===================== 締め月ロジック(21日始まり・20日締め) ===================== */
function closingRangeDates(year, month){
  let endY=year, endM=month, endD=20, startY=year, startM=month-1, startD=21;
  if(startM === 0){ startM = 12; startY = year - 1; }
  return { start: new Date(startY, startM-1, startD, 0,0,0), end: new Date(endY, endM-1, endD, 23,59,59) };
}
function closingRange(year, month){
  const r = closingRangeDates(year, month);
  const fmt = d => `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
  return { start: fmt(r.start), end: fmt(r.end) };
}
function today_(){
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}

/* 締め月のデフォルト値: 21〜末日は当月の20日〆(直近で締まった期間)、1〜20日も当月の20日〆(進行中の期間) */
function defaultClosingYearMonth_(){
  const s = today_();
  return { year: Number(s.slice(0,4)), month: Number(s.slice(4,6)) };
}

/* ①日報入力チェック専用: 「本日の日付」が含まれる締め期間(進行中の場合を含む)を返す。
   1〜20日はdefaultClosingYearMonth_と同じ値になるが、21〜31日は+1ヶ月になる点が異なる
   (defaultClosingYearMonth_はその場合「直近で締まった期間」を返す設計のため)。 */
function currentClosingMonth_(){
  const day = Number(today_().slice(6,8));
  const def = defaultClosingYearMonth_();
  if(day <= 20) return def;
  let m = def.month + 1, y = def.year;
  if(m === 13){ m = 1; y += 1; }
  return { year: y, month: m };
}

/* ===================== 期間ピッカーUI ===================== */
function buildPeriodPicker(containerId, prefix){
  const el = document.getElementById(containerId);
  const def = defaultClosingYearMonth_();
  const years = [def.year-2, def.year-1, def.year, def.year+1];
  const yearOpts = years.map(y=>`<option value="${y}" ${y===def.year?'selected':''}>${y}年</option>`).join('');
  const monthOpts = Array.from({length:12},(_,i)=>i+1)
    .map(m=>`<option value="${m}" ${m===def.month?'selected':''}>${m}月20日締め</option>`).join('');
  const defRange = closingRange(def.year, def.month);

  el.innerHTML = `
    <div class="field">
      <label>期間の指定方法</label>
      <div class="radioGroup" id="${prefix}-mode">
        <label class="radioBtn checked"><input type="radio" name="${prefix}mode" value="closing" checked>締め月で選択</label>
        <label class="radioBtn"><input type="radio" name="${prefix}mode" value="free">自由日付で選択</label>
      </div>
    </div>
    <div class="field" id="${prefix}-closingFields">
      <label>締め月</label>
      <div style="display:flex; gap:6px;">
        <select id="${prefix}-year">${yearOpts}</select>
        <select id="${prefix}-month">${monthOpts}</select>
      </div>
      <div class="rangePreview" id="${prefix}-rangePreview"></div>
    </div>
    <div class="field" id="${prefix}-freeFields" style="display:none;">
      <label>期間(自由日付)</label>
      <div class="dateRangeRow">
        <input type="date" id="${prefix}-from" value="${defRange.start.split('/').join('-')}">
        <span>〜</span>
        <input type="date" id="${prefix}-to" value="${defRange.end.split('/').join('-')}">
      </div>
    </div>
  `;

  const recomputeTrigger = () => triggerRecompute(prefix);

  const modeRadios = el.querySelectorAll(`input[name="${prefix}mode"]`);
  modeRadios.forEach(r => r.addEventListener('change', () => {
    el.querySelectorAll(`#${prefix}-mode .radioBtn`).forEach(b=>b.classList.remove('checked'));
    r.closest('.radioBtn').classList.add('checked');
    const isClosing = r.value === 'closing';
    el.querySelector(`#${prefix}-closingFields`).style.display = isClosing ? '' : 'none';
    el.querySelector(`#${prefix}-freeFields`).style.display = isClosing ? 'none' : '';
    recomputeTrigger();
  }));

  const updatePreview = () => {
    const y = Number(el.querySelector(`#${prefix}-year`).value);
    const m = Number(el.querySelector(`#${prefix}-month`).value);
    const r = closingRange(y,m);
    el.querySelector(`#${prefix}-rangePreview`).textContent = `対象期間: ${r.start} 〜 ${r.end}`;
    recomputeTrigger();
  };
  el.querySelector(`#${prefix}-year`).addEventListener('change', updatePreview);
  el.querySelector(`#${prefix}-month`).addEventListener('change', updatePreview);
  el.querySelector(`#${prefix}-from`).addEventListener('change', recomputeTrigger);
  el.querySelector(`#${prefix}-to`).addEventListener('change', recomputeTrigger);
  updatePreview();
}

/* 締め月選択のみ(自由日付トグルなし)。20日〆集計専用 */
function buildClosingOnlyPicker(containerId, prefix){
  const el = document.getElementById(containerId);
  const def = defaultClosingYearMonth_();
  const years = [def.year-2, def.year-1, def.year, def.year+1];
  const yearOpts = years.map(y=>`<option value="${y}" ${y===def.year?'selected':''}>${y}年</option>`).join('');
  const monthOpts = Array.from({length:12},(_,i)=>i+1)
    .map(m=>`<option value="${m}" ${m===def.month?'selected':''}>${m}月20日締め</option>`).join('');

  el.innerHTML = `
    <div class="field">
      <label>締め月</label>
      <div style="display:flex; gap:6px;">
        <select id="${prefix}-year">${yearOpts}</select>
        <select id="${prefix}-month">${monthOpts}</select>
      </div>
      <div class="rangePreview" id="${prefix}-rangePreview"></div>
    </div>
  `;

  const updatePreview = () => {
    const y = Number(el.querySelector(`#${prefix}-year`).value);
    const m = Number(el.querySelector(`#${prefix}-month`).value);
    const r = closingRange(y,m);
    el.querySelector(`#${prefix}-rangePreview`).textContent = `対象期間: ${r.start} 〜 ${r.end}`;
    renderR3Preview();
  };
  el.querySelector(`#${prefix}-year`).addEventListener('change', updatePreview);
  el.querySelector(`#${prefix}-month`).addEventListener('change', updatePreview);
  updatePreview();
}

function getPeriodLabel(prefix, specName){
  const specVal = document.querySelector(`input[name="${specName}"]:checked`).value;
  if(specVal !== 'yes') return { label: '全期間', range: 'ALL' };
  const mode = document.querySelector(`input[name="${prefix}mode"]:checked`).value;
  if(mode === 'closing'){
    const y = document.getElementById(`${prefix}-year`).value;
    const m = document.getElementById(`${prefix}-month`).value;
    const r = closingRange(Number(y), Number(m));
    return { label: `${y}年${m}月20日締め`, range: `${r.start}-${r.end}` };
  }
  const from = document.getElementById(`${prefix}-from`).value;
  const to = document.getElementById(`${prefix}-to`).value;
  return { label: `${from}〜${to}`, range: `${from}_${to}` };
}

function getClosingPeriodLabel(prefix){
  const y = document.getElementById(`${prefix}-year`).value;
  const m = document.getElementById(`${prefix}-month`).value;
  const r = closingRange(Number(y), Number(m));
  return { label: `${y}年${m}月20日締め`, range: `${r.start}-${r.end}` };
}

/* ===================== チップ・スペックトグル共通挙動 ===================== */

/* チップを全て選択したら「指定:する」を自動で「しない」に戻す(全選択=フィルタなしと同じ意味のため) */
function maybeAutoSwitchToNo(fieldEl){
  const checkGroup = fieldEl.querySelector('.checkGroup');
  if(!checkGroup) return;
  const boxes = Array.from(checkGroup.querySelectorAll('input[type=checkbox]'))
    .filter(b => b.closest('.checkBtn').style.display !== 'none');
  if(boxes.length === 0 || !boxes.every(b=>b.checked)) return;
  const noRadio = fieldEl.querySelector('.specToggle input[value="no"]');
  if(!noRadio || noRadio.checked) return;
  noRadio.checked = true;
  noRadio.dispatchEvent(new Event('change'));
}

const searchQueries = {}; // groupId -> 現在の検索文字列

function applyChipVisibility(groupId){
  const q = (searchQueries[groupId] || '').trim();
  document.querySelectorAll(`#${groupId} .checkBtn`).forEach(label=>{
    const matchesSearch = !q || label.textContent.includes(q);
    const available = label.dataset.available !== 'false';
    label.style.display = (matchesSearch && available) ? '' : 'none';
  });
}

function filterChips(groupId, query){
  searchQueries[groupId] = query;
  applyChipVisibility(groupId);
}

function fieldContainerScreenKey(el){
  if(el.closest('#screen-report1')) return 'r1';
  if(el.closest('#screen-report2')) return 'r2';
  if(el.closest('#screen-report3')) return 'r3';
  if(el.closest('#screen-report4')) return 'r4';
  return null;
}

function triggerRecompute(screenKey){
  if(screenKey === 'r1' || screenKey === 'r2') recomputeScreen(screenKey);
  else if(screenKey === 'r3') renderR3Preview();
  else if(screenKey === 'r4') withRecalcPopup(renderR4Preview);
}

/* checkBtn(チェックボックス)へのイベント配線は、動的に生成される
   #r1-name/#r1-work/#r2-construction/#r2-work等も含めて委譲で1箇所にまとめる
   (populateMasterUi_で毎回作り直されるため、個別バインドだと再生成後に失われる)。 */
document.addEventListener('change', e => {
  const cb = e.target.closest('.checkBtn input[type=checkbox]');
  if(cb){
    cb.closest('.checkBtn').classList.toggle('checked', cb.checked);
    const field = cb.closest('.field');
    if(field) maybeAutoSwitchToNo(field);
    triggerRecompute(fieldContainerScreenKey(cb));
    return;
  }
  const specRadio = e.target.closest('.specToggle input[type=radio]');
  if(specRadio){
    const toggle = specRadio.closest('.specToggle');
    const body = toggle.closest('.field').querySelector('.specBody');
    toggle.querySelectorAll('.specBtn').forEach(b=>b.classList.remove('checked'));
    specRadio.closest('.specBtn').classList.add('checked');
    if(body) body.classList.toggle('open', specRadio.value === 'yes');
    triggerRecompute(fieldContainerScreenKey(specRadio));
  }
});

/* ===================== マスタデータをUIへ反映 ===================== */

function buildOptionsHtml_(items, valueFn, labelFn, classFn){
  return items.map(item => {
    const cls = classFn ? classFn(item) : '';
    return `<option value="${valueFn(item)}"${cls ? ` class="${cls}"` : ''}>${labelFn(item)}</option>`;
  }).join('');
}

function buildChipsHtml_(items, valueFn, labelFn, classFn){
  return items.map(item => {
    const cls = classFn ? (' ' + classFn(item)) : '';
    return `<label class="checkBtn${cls}"><input type="checkbox" value="${valueFn(item)}">${labelFn(item)}</label>`;
  }).join('');
}

const DEPT_LABEL = { '工場': '工場', '設計管理': '事務' };

/* MASTER取得後、①〜③の選択肢(工事/社員/作業内容)を実データで組み立てる。
   拠点(本社/夢前/鳥取)・部署(工場/事務)は固定の分類のためindex.htmlに
   静的に書かれたままで変更不要。 */
function populateMasterUi_(){
  // ① 工事別: 工事セレクト・氏名チップ・作業内容チップ
  const r1Select = document.getElementById('r1-construction');
  r1Select.innerHTML = '<option value="">-- 選択してください --</option>' +
    buildOptionsHtml_(MASTER.constructions, c => c.id, c => c.name);

  document.getElementById('r1-name').innerHTML = buildChipsHtml_(
    MASTER.operators, o => o.no, o => `${o.factory} ${o.name}`, o => o.retired ? 'retired' : ''
  );
  document.getElementById('r1-work').innerHTML = buildChipsHtml_(
    MASTER.workItems, w => w.code, w => `${w.code} ${w.name}`
  );

  // ② 個人別: 社員セレクト・工事チップ・作業内容チップ
  const r2Select = document.getElementById('r2-operator');
  r2Select.innerHTML = '<option value="">-- 選択してください --</option>' +
    buildOptionsHtml_(
      MASTER.operators, o => o.no,
      o => `${o.name}(${o.factory}/${DEPT_LABEL[o.dept] || o.dept}${o.retired ? '・退職済' : ''})`
    );
  document.getElementById('r2-construction').innerHTML = buildChipsHtml_(
    MASTER.constructions, c => c.id, c => c.name
  );
  document.getElementById('r2-work').innerHTML = buildChipsHtml_(
    MASTER.workItems, w => w.code, w => `${w.code} ${w.name}`
  );
}

/* ===================== アプリ起動時のデータ読み込み ===================== */

const INITIAL_LOAD_PROGRESS_DURATION_MS = 15000;

function setHomeButtonsEnabled(enabled){
  document.querySelectorAll('.homeBtn').forEach(b => { b.disabled = !enabled; });
}

/* アプリ起動時、ホーム画面表示と同時に同期ポップアップを出し、①②③④を押せない状態にする。
   実データ取得が完了した時点でポップアップを閉じる(最低表示時間は待たない)。 */
async function initSyncPopup(){
  const startedAt = showFakeProgress('日報アプリと同期しています', INITIAL_LOAD_PROGRESS_DURATION_MS, true);
  try {
    await loadAllData();
    hideFakeProgressNow(() => setHomeButtonsEnabled(true));
  } catch (err) {
    hideFakeProgressNow(() => {
      showToast('データの取得に失敗しました: ' + err.message);
    });
  }
}

async function loadAllData(){
  const [master, rows, calendar, absenteeism] = await Promise.all([
    apiPost('getMasterData'),
    apiPost('getAllDailyReportRows'),
    apiPost('getCompanyCalendarData'),
    apiPost('getAbsenteeismData'),
  ]);
  MASTER = master;
  ALL_ROWS = rows.map(r => Object.assign({}, r, { _date: new Date(r.workDate.split('/').join('-')) }));
  CALENDAR_MAP = calendar;
  ABSENTEEISM = absenteeism;

  buildMasterDependentMaps_();
  populateMasterUi_();
  applyDefaultFactoryToAllScreens_();
  updateHeaderFactoryLabels_();
  // MASTER.earliestArchiveYearが判明したので、締め月選択リストの下限を反映して作り直す
  buildMonthPicker('r4-month', 'r4');

  recomputeScreen('r1');
  recomputeScreen('r2');
  renderR3Preview();
  renderR4Preview();
}

function showScreen(name){
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById('screen-'+name).classList.add('active');
  window.scrollTo(0,0);
  /* ①日報入力チェックのsticky積み重ね(集計条件パネル/ファイル名見出し/th)は
     実測した高さをtopに使うため、画面がdisplay:noneの間に描画されると
     高さが0として計算されてしまう。この画面を表示した直後に測り直す。 */
  if(name === 'report4') adjustR4StickyOffset_();
}

function showToast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), 2200);
}

/* プレビュー表のセルクリック時、全文をそのセルの右上に表示する。
   位置決めのため一旦テキストをセットしてレイアウトさせてから
   getBoundingClientRectでサイズを測り、最終位置を計算する。 */
let cellTextPopupTimer = null;
function showCellTextPopup(cell){
  const popup = document.getElementById('cellTextPopup');
  const rect = cell.getBoundingClientRect();
  popup.textContent = cell.textContent.trim();
  popup.classList.add('show');
  const popupRect = popup.getBoundingClientRect();
  let left = rect.right - popupRect.width;
  let top = rect.top - popupRect.height - 6;
  left = Math.max(4, Math.min(left, window.innerWidth - popupRect.width - 4));
  if(top < 4) top = rect.bottom + 6; // 一番上の行など、上に出す余白がなければ下に表示
  popup.style.left = left + 'px';
  popup.style.top = top + 'px';
  if(cellTextPopupTimer) clearTimeout(cellTextPopupTimer);
  cellTextPopupTimer = setTimeout(() => popup.classList.remove('show'), 2200);
}

/* ①日報入力チェック専用: 範囲が広く重い同期処理(fn)の前後で「再計算中」
   ポップアップを出す。setTimeoutで1tick遅らせてからfnを実行することで、
   ポップアップが実際に描画されてから重い処理を始められるようにしている
   (先にfnを同期実行すると、ポップアップを表示する前にブラウザが固まる)。
   fn完了と同時に消える(最低表示時間などの演出はない)。 */
function withRecalcPopup(fn){
  const overlay = document.getElementById('recalcOverlay');
  overlay.classList.add('show');
  setTimeout(() => {
    fn();
    overlay.classList.remove('show');
  }, 0);
}

/* ===================== ロック画面(パスワード) ===================== */
/* パスワードはアプリを開いた日の「日(day)」の一の位の数字。ロゴを2秒以内に
   5回連続タップ(クリック)すると3秒間だけポップアップ表示される。 */
const LOCK_TAP_TARGET = 5;
const LOCK_TAP_WINDOW_MS = 2000;
const LOCK_POPUP_DURATION_MS = 3000;
let lockTapCount = 0;
let lockTapLastAt = 0;

function todayPasswordDigit_(){
  const day = parseInt(today_().slice(6, 8), 10);
  return String(day % 10);
}

function handleLockLogoTap(){
  const now = Date.now();
  if(now - lockTapLastAt > LOCK_TAP_WINDOW_MS) lockTapCount = 0;
  lockTapLastAt = now;
  lockTapCount++;
  if(lockTapCount >= LOCK_TAP_TARGET){
    lockTapCount = 0;
    showLockPasswordPopup();
  }
}

function showLockPasswordPopup(){
  const popup = document.getElementById('lockPasswordPopup');
  popup.textContent = todayPasswordDigit_();
  popup.classList.add('show');
  setTimeout(() => popup.classList.remove('show'), LOCK_POPUP_DURATION_MS);
}

function submitLockPassword(){
  const input = document.getElementById('lock-input');
  const val = input.value.trim();
  input.value = '';
  input.focus();
  if(val === todayPasswordDigit_()){
    sessionStorage.setItem('unlocked', '1');
    showScreen('factory');
  } else {
    showToast('パスワードが違います');
  }
}

/* ===================== 工場選択画面(ログイン後のデフォルト工場) ===================== */
function getDefaultFactory_(){
  return sessionStorage.getItem('defaultFactory') || '';
}

function updateHeaderFactoryLabels_(){
  const loc = getDefaultFactory_();
  document.querySelectorAll('.headerFactoryLabel').forEach(el => { el.textContent = loc; });
  const homeLabel = document.getElementById('homeFactoryLabel');
  if(homeLabel) homeLabel.textContent = loc ? `(工場: ${loc})` : '';
}

/* r1/r2は「指定:する」+選択工場のみチェック、r3は選択工場のみチェックにする。
   すでにログイン済みで各画面を開き直した時、およびリセット時の両方で使う。 */
function applyDefaultFactoryFilter_(prefix){
  const factory = getDefaultFactory_();
  if(!factory) return;
  if(prefix === 'r1' || prefix === 'r2'){
    const specName = prefix + '-loc-spec';
    const groupId = prefix + '-loc';
    document.querySelectorAll(`input[name="${specName}"]`).forEach(r => r.closest('.specBtn').classList.remove('checked'));
    const yesRadio = document.querySelector(`input[name="${specName}"][value="yes"]`);
    yesRadio.checked = true;
    yesRadio.closest('.specBtn').classList.add('checked');
    const body = yesRadio.closest('.field').querySelector('.specBody');
    if(body) body.classList.add('open');
    document.querySelectorAll(`#${groupId} input[type=checkbox]`).forEach(cb=>{
      const match = cb.value === factory;
      cb.checked = match;
      cb.closest('.checkBtn').classList.toggle('checked', match);
    });
  } else if(prefix === 'r3'){
    document.querySelectorAll('#r3-locations input[type=checkbox]').forEach(cb=>{
      const match = cb.value === factory;
      cb.checked = match;
      cb.closest('.checkBtn').classList.toggle('checked', match);
    });
  } else if(prefix === 'r4'){
    document.querySelectorAll('#r4-locations input[type=checkbox]').forEach(cb=>{
      const match = cb.value === factory;
      cb.checked = match;
      cb.closest('.checkBtn').classList.toggle('checked', match);
    });
  }
}

function applyDefaultFactoryToAllScreens_(){
  applyDefaultFactoryFilter_('r1');
  applyDefaultFactoryFilter_('r2');
  applyDefaultFactoryFilter_('r3');
  applyDefaultFactoryFilter_('r4');
}

/* ログイン(工場選択)時の記録。日時・工場だけを記録すれば十分なため、
   滞在時間(C列)の追記は行わない(ユーザー指定。同時ログイン時の行ズレの
   原因を減らす意味もある)。 */
async function selectFactory(loc){
  sessionStorage.setItem('defaultFactory', loc);
  updateHeaderFactoryLabels_();
  showScreen('home');
  try {
    await apiPost('logFactorySelection', { factory: loc });
  } catch (e) {
    // ログイン記録に失敗しても本体機能には影響させない(ベストエフォート)
  }
  initSyncPopup();
}

function checkedSummary(specName, groupId){
  const specVal = document.querySelector(`input[name="${specName}"]:checked`).value;
  if(specVal === 'no') return '全て';
  const boxes = Array.from(document.querySelectorAll(`#${groupId} input[type=checkbox]`));
  const checked = boxes.filter(b=>b.checked);
  if(checked.length === 0) return '(未選択)';
  return checked.map(b=>b.closest('.checkBtn').textContent.trim()).join(', ');
}

/* ===================== ①②のカスケード絞り込みエンジン ===================== */

const SCREEN_CONFIG = {
  r1: {
    primary: { id:'r1-construction', field:'constructionId' },
    dims: [
      { key:'loc',  specName:'r1-loc-spec',  groupId:'r1-loc',  field:'factory' },
      { key:'dept', specName:'r1-dept-spec', groupId:'r1-dept', field:'dept' },
      { key:'name', specName:'r1-name-spec', groupId:'r1-name', field:'operatorNo' },
      { key:'work', specName:'r1-work-spec', groupId:'r1-work', field:'workCode' }
    ],
    periodPrefix:'r1', periodSpecName:'r1-period-spec'
  },
  r2: {
    primary: { id:'r2-operator', field:'operatorNo' },
    dims: [
      { key:'loc',  specName:'r2-loc-spec',  groupId:'r2-loc',  field:'factory' },
      { key:'dept', specName:'r2-dept-spec', groupId:'r2-dept', field:'dept' },
      { key:'construction', specName:'r2-construction-spec', groupId:'r2-construction', field:'constructionId' },
      { key:'work', specName:'r2-work-spec', groupId:'r2-work', field:'workCode' }
    ],
    periodPrefix:'r2', periodSpecName:'r2-period-spec'
  }
};

function dimSelectedValues(dim){
  const specVal = document.querySelector(`input[name="${dim.specName}"]:checked`).value;
  if(specVal !== 'yes') return null;
  const vals = Array.from(document.querySelectorAll(`#${dim.groupId} input[type=checkbox]:checked`)).map(i=>i.value);
  return vals.length ? vals : null;
}

function periodRestriction(prefix, specName){
  const specVal = document.querySelector(`input[name="${specName}"]:checked`).value;
  if(specVal !== 'yes') return null;
  const mode = document.querySelector(`input[name="${prefix}mode"]:checked`).value;
  if(mode === 'closing'){
    const y = Number(document.getElementById(`${prefix}-year`).value);
    const m = Number(document.getElementById(`${prefix}-month`).value);
    return closingRangeDates(y, m);
  }
  const from = document.getElementById(`${prefix}-from`).value;
  const to = document.getElementById(`${prefix}-to`).value;
  if(!from || !to) return null;
  const end = new Date(to); end.setHours(23,59,59);
  return { start: new Date(from), end: end };
}

function buildPredicate(cfg, excludeKey){
  const checks = [];
  if(excludeKey !== 'primary'){
    const sel = document.getElementById(cfg.primary.id);
    const pv = sel.value;
    if(pv) checks.push(r => String(r[cfg.primary.field]) === pv);
  }
  cfg.dims.forEach(dim=>{
    if(dim.key === excludeKey) return;
    const vals = dimSelectedValues(dim);
    if(vals) checks.push(r => vals.indexOf(String(r[dim.field])) !== -1);
  });
  if(excludeKey !== 'period'){
    const range = periodRestriction(cfg.periodPrefix, cfg.periodSpecName);
    if(range) checks.push(r => r._date >= range.start && r._date <= range.end);
  }
  return row => checks.every(fn => fn(row));
}

function filteredRows(cfg, excludeKey){
  const pred = buildPredicate(cfg, excludeKey);
  return ALL_ROWS.filter(pred);
}

function updateDimAvailability(cfg){
  cfg.dims.forEach(dim=>{
    const rowsExcl = filteredRows(cfg, dim.key);
    const available = new Set(rowsExcl.map(r => String(r[dim.field])));
    document.querySelectorAll(`#${dim.groupId} input[type=checkbox]`).forEach(cb=>{
      const label = cb.closest('.checkBtn');
      const isAvailable = available.has(cb.value);
      label.dataset.available = isAvailable ? 'true' : 'false';
      if(!isAvailable && cb.checked){
        cb.checked = false;
        label.classList.remove('checked');
      }
    });
    applyChipVisibility(dim.groupId);
  });
}

function updatePrimaryAvailability(cfg){
  const rowsExclPrimary = filteredRows(cfg, 'primary');
  const available = new Set(rowsExclPrimary.map(r => String(r[cfg.primary.field])));
  const sel = document.getElementById(cfg.primary.id);
  Array.from(sel.options).forEach(opt=>{
    if(!opt.value) return;
    const ok = available.has(opt.value);
    opt.disabled = !ok;
    opt.style.display = ok ? '' : 'none';
  });
  if(sel.value && !available.has(sel.value)) sel.value = '';
}

function recomputeScreen(screenKey){
  const cfg = SCREEN_CONFIG[screenKey];
  updateDimAvailability(cfg);
  updateDimAvailability(cfg); // 相互カスケードを収束させるため2回実施
  updatePrimaryAvailability(cfg);
  if(screenKey === 'r1') renderR1Preview();
  if(screenKey === 'r2') renderR2Preview();
}

/* ===================== プレビュー描画 ===================== */

/* テーブルセルが省略(ellipsis)されている場合、ホバーで全文が見えるようtitle属性を付与 */
function applyCellTooltips(tableEl){
  if(!tableEl) return;
  tableEl.querySelectorAll('td, th').forEach(cell=>{
    if(cell.scrollWidth > cell.clientWidth) cell.title = cell.textContent.trim();
  });
}

function renderR1Preview(){
  const previewEl = document.getElementById('r1-preview');
  const sel = document.getElementById('r1-construction');
  const constructionId = sel.value;
  if(!constructionId){
    previewEl.innerHTML = `<h3>プレビュー(作業内容別 合計時間)</h3><div class="previewEmpty">工事を選択すると、ここに集計結果がリアルタイムで表示されます</div>`;
    return;
  }
  const cName = sel.options[sel.selectedIndex].text;
  const allRows = filteredRows(SCREEN_CONFIG.r1, null);
  const period = getPeriodLabel('r1','r1-period-spec');
  const locSummary = checkedSummary('r1-loc-spec','r1-loc');
  const deptSummary = checkedSummary('r1-dept-spec','r1-dept');
  const nameSummary = checkedSummary('r1-name-spec','r1-name');
  const workSummary = checkedSummary('r1-work-spec','r1-work');
  const fileName = `工事別集計_${cName.replace(/[\s　]/g,'')}_${period.range}_${today_()}.xlsx`;
  const summaryHtml = `<div class="filterSummary">工場: ${locSummary} ／ 部署: ${deptSummary} ／ 氏名: ${nameSummary} ／ 作業内容: ${workSummary}</div>`;

  const locSpecVal = document.querySelector('input[name="r1-loc-spec"]:checked').value;
  const locs = locSpecVal === 'yes'
    ? Array.from(document.querySelectorAll('#r1-loc input[type=checkbox]:checked')).map(cb=>cb.value)
    : FACTORY_ORDER.filter(f => allRows.some(r=>r.factory===f));

  if(locs.length === 0){
    previewEl.innerHTML = `
      <div class="fileNamePreview">ファイル名: ${fileName}</div>
      <h3>プレビュー(作業内容別 合計時間) — ${cName} / ${period.label}</h3>
      ${summaryHtml}
      <div class="previewEmpty">該当するデータがありません</div>`;
    return;
  }

  let blocksHtml = '';
  locs.forEach(loc=>{
    const locRows = allRows.filter(r => r.factory === loc);
    const sums = {};
    locRows.forEach(r=>{ sums[r.workCode] = (sums[r.workCode]||0) + r.hours; });
    const codes = Object.keys(sums).sort();
    const factoryCodes = codes.filter(c => WORK_DEPT[c] === '工場');
    const officeCodes = codes.filter(c => WORK_DEPT[c] !== '工場');

    blocksHtml += `<tr class="sheetHeadRow"><td colspan="2">シート: ${loc}</td></tr>`;
    if(codes.length === 0){
      blocksHtml += `<tr><td colspan="2" class="previewEmptyCell">該当するデータがありません</td></tr>`;
      return;
    }

    let grand = 0;
    if(factoryCodes.length){
      let fTotal = 0;
      factoryCodes.forEach(code=>{
        fTotal += sums[code];
        blocksHtml += `<tr class="rowFactory"><td>${WORK_META[code]||code}</td><td class="num">${sums[code].toFixed(1)}</td></tr>`;
      });
      blocksHtml += `<tr class="rowFactoryTotal"><td>工場 小計</td><td class="num">${fTotal.toFixed(1)}</td></tr>`;
      grand += fTotal;
    }
    if(officeCodes.length){
      let oTotal = 0;
      officeCodes.forEach(code=>{
        oTotal += sums[code];
        blocksHtml += `<tr class="rowOffice"><td>${WORK_META[code]||code}</td><td class="num">${sums[code].toFixed(1)}</td></tr>`;
      });
      blocksHtml += `<tr class="rowOfficeTotal"><td>事務 小計</td><td class="num">${oTotal.toFixed(1)}</td></tr>`;
      grand += oTotal;
    }
    blocksHtml += `<tr class="totalRow"><td>総合計</td><td class="num">${grand.toFixed(1)}</td></tr>`;
  });

  previewEl.innerHTML = `
    <div class="fileNamePreview">ファイル名: ${fileName}</div>
    <h3>プレビュー(作業内容別 合計時間) — ${cName} / ${period.label}</h3>
    ${summaryHtml}
    <table class="dataTable">
      <tr><th>作業内容</th><th>合計時間</th></tr>
      ${blocksHtml}
    </table>`;
  applyCellTooltips(previewEl.querySelector('.dataTable'));
}

function renderR2Preview(){
  const previewEl = document.getElementById('r2-preview');
  const sel = document.getElementById('r2-operator');
  const operatorNo = sel.value;
  if(!operatorNo){
    previewEl.innerHTML = `<h3>プレビュー(日付別 明細)</h3><div class="previewEmpty">社員を選択すると、ここに集計結果がリアルタイムで表示されます</div>`;
    return;
  }
  const opText = sel.options[sel.selectedIndex].text;
  const rows = filteredRows(SCREEN_CONFIG.r2, null).slice().sort((a,b)=> a._date - b._date);
  const period = getPeriodLabel('r2','r2-period-spec');
  const locSummary = checkedSummary('r2-loc-spec','r2-loc');
  const deptSummary = checkedSummary('r2-dept-spec','r2-dept');
  const constructionSummary = checkedSummary('r2-construction-spec','r2-construction');
  const workSummary = checkedSummary('r2-work-spec','r2-work');
  const fileName = `個人集計_${opText.replace(/[\s　]/g,'')}_${period.range}_${today_()}.xlsx`;
  const summaryHtml = `<div class="filterSummary">工場: ${locSummary} ／ 部署: ${deptSummary} ／ 工事: ${constructionSummary} ／ 作業内容: ${workSummary}</div>`;

  if(rows.length === 0){
    previewEl.innerHTML = `
      <div class="fileNamePreview">ファイル名: ${fileName}</div>
      <h3>プレビュー(日付別明細) — ${opText} / ${period.label}</h3>
      ${summaryHtml}
      <div class="previewEmpty">該当するデータがありません</div>`;
    return;
  }

  let total = 0;
  const bodyRows = rows.map(r=>{
    total += r.hours;
    return `<tr><td>${r.workDate}</td><td>${CONSTRUCTION_LABEL[r.constructionId]||r.constructionId}</td><td>${WORK_META[r.workCode]||r.workCode}</td><td class="num">${r.hours.toFixed(1)}</td></tr>`;
  }).join('');

  previewEl.innerHTML = `
    <div class="fileNamePreview">ファイル名: ${fileName}</div>
    <h3>プレビュー(日付別明細) — ${opText} / ${period.label}</h3>
    ${summaryHtml}
    <table class="dataTable">
      <tr><th>作業日</th><th>工事</th><th>作業内容</th><th>時間</th></tr>
      ${bodyRows}
      <tr class="totalRow"><td colspan="3">合計</td><td class="num">${total.toFixed(1)}</td></tr>
    </table>`;
  applyCellTooltips(previewEl.querySelector('.dataTable'));
}

function renderR3Preview(){
  const previewEl = document.getElementById('r3-preview');
  const locs = Array.from(document.querySelectorAll('#r3-locations input:checked')).map(i=>i.value);
  if(locs.length === 0){
    previewEl.innerHTML = `<h3>プレビュー(工事×作業内容 クロス集計・拠点ごとに別シート)</h3><div class="previewEmpty">拠点を選択すると、ここに集計結果がリアルタイムで表示されます</div>`;
    return;
  }
  const year = Number(document.getElementById('r3-year').value);
  const month = Number(document.getElementById('r3-month').value);
  const range = closingRangeDates(year, month);
  const period = getClosingPeriodLabel('r3');
  const fileName = `20日締め集計_${locs.join('+')}_${period.range}_${today_()}.xlsx`;
  const periodRows = ALL_ROWS.filter(r => r._date >= range.start && r._date <= range.end);

  let rowsHtml = '';
  locs.forEach(loc=>{
    const locRows = periodRows.filter(r => r.factory === loc);
    const byConstruction = {};
    const order = [];
    locRows.forEach(r=>{
      if(!byConstruction[r.constructionId]){
        byConstruction[r.constructionId] = { name: CONSTRUCTION_LABEL[r.constructionId] || r.constructionId, codes:{} };
        order.push(r.constructionId);
      }
      byConstruction[r.constructionId].codes[r.workCode] = (byConstruction[r.constructionId].codes[r.workCode]||0) + r.hours;
    });
    order.sort((a,b) => String(CONSTRUCTION_NO[a]||'').localeCompare(String(CONSTRUCTION_NO[b]||''), 'ja', {numeric:true}));

    const usedCodes = {};
    order.forEach(cid => Object.keys(byConstruction[cid].codes).forEach(c => usedCodes[c] = true));
    const factoryCodes = [], officeCodes = [];
    Object.keys(usedCodes).sort().forEach(code=>{
      (WORK_DEPT[code] === '工場' ? factoryCodes : officeCodes).push(code);
    });

    if(order.length === 0){
      rowsHtml += `<tr class="sheetHeadRow"><td colspan="4">シート: ${loc}(該当データなし)</td></tr>`;
      return;
    }

    rowsHtml += `<tr class="sheetHeadRow"><td colspan="${1+factoryCodes.length+1+officeCodes.length+1+1}">シート: ${loc}</td></tr>`;
    rowsHtml += `<tr>
      <th rowspan="2">工事</th>
      ${factoryCodes.length ? `<th colspan="${factoryCodes.length+1}" class="colFactory">工場</th>` : `<th class="colFactoryTotal">工場合計</th>`}
      ${officeCodes.length ? `<th colspan="${officeCodes.length+1}" class="colOffice">事務</th>` : `<th class="colOfficeTotal">事務合計</th>`}
      <th rowspan="2" class="colGrand">総合計</th>
    </tr>`;
    rowsHtml += `<tr>
      ${factoryCodes.map(c=>`<th class="colFactory">${WORK_META[c]||c}</th>`).join('')}
      <th class="colFactoryTotal">工場合計</th>
      ${officeCodes.map(c=>`<th class="colOffice">${WORK_META[c]||c}</th>`).join('')}
      <th class="colOfficeTotal">事務合計</th>
    </tr>`;

    const colTotals = {};
    factoryCodes.concat(officeCodes).forEach(c => colTotals[c] = 0);
    let grandFactoryTotal = 0, grandOfficeTotal = 0;

    order.forEach(cid=>{
      const c = byConstruction[cid];
      let fTotal = 0, oTotal = 0;
      const factoryCells = factoryCodes.map(code=>{
        const v = c.codes[code] || 0; fTotal += v; colTotals[code] += v;
        return `<td class="num colFactory">${v.toFixed(1)}</td>`;
      }).join('');
      const officeCells = officeCodes.map(code=>{
        const v = c.codes[code] || 0; oTotal += v; colTotals[code] += v;
        return `<td class="num colOffice">${v.toFixed(1)}</td>`;
      }).join('');
      grandFactoryTotal += fTotal; grandOfficeTotal += oTotal;
      rowsHtml += `<tr>
        <td>${c.name}</td>
        ${factoryCells}<td class="num colFactoryTotal">${fTotal.toFixed(1)}</td>
        ${officeCells}<td class="num colOfficeTotal">${oTotal.toFixed(1)}</td>
        <td class="num colGrand">${(fTotal+oTotal).toFixed(1)}</td>
      </tr>`;
    });

    rowsHtml += `<tr class="totalRow">
      <td>合計</td>
      ${factoryCodes.map(code=>`<td class="num colFactory">${colTotals[code].toFixed(1)}</td>`).join('')}
      <td class="num colFactoryTotal">${grandFactoryTotal.toFixed(1)}</td>
      ${officeCodes.map(code=>`<td class="num colOffice">${colTotals[code].toFixed(1)}</td>`).join('')}
      <td class="num colOfficeTotal">${grandOfficeTotal.toFixed(1)}</td>
      <td class="num colGrand">${(grandFactoryTotal+grandOfficeTotal).toFixed(1)}</td>
    </tr>`;
  });

  previewEl.innerHTML = `
    <div class="fileNamePreview">ファイル名: ${fileName}</div>
    <h3>プレビュー(拠点ごとに別シート) / ${period.label}</h3>
    <table class="dataTable">${rowsHtml}</table>`;
  applyCellTooltips(previewEl.querySelector('.dataTable'));
}

/* ===================== ①日報入力チェック ===================== */

const R4_WEEKDAY_NAMES = ['日','月','火','水','木','金','土'];

function checkedValues(groupId){
  return Array.from(document.querySelectorAll(`#${groupId} input[type=checkbox]:checked`)).map(i=>i.value);
}

/* 締め月選択(ドロップダウン、単一選択)。本日を含む進行中の締め期間から、
   実際に登録されているアーカイブのうち最も古いもの(MASTER.earliestArchiveYear、
   例: 2024)の開始日(年/11/21)を含む締め月(その年の12月20日締め)までを選択肢にする。
   下限をハードコードせず、GAS側で「情報」シートから都度求めた値を使うため、
   将来アーカイブが入れ替わっても選択範囲が自動的に追従する。 */
function buildMonthPicker(containerId, prefix){
  const el = document.getElementById(containerId);
  const def = currentClosingMonth_();
  const earliestYear = MASTER.earliestArchiveYear != null ? MASTER.earliestArchiveYear : def.year;

  const months = [];
  let y = def.year, m = def.month;
  const MAX_MONTHS = 600; // 50年分。異常なMASTER値による無限ループを防ぐ安全策
  for(let i = 0; i < MAX_MONTHS; i++){
    months.push({ year: y, month: m });
    if(y === earliestYear && m === 12) break;
    m -= 1;
    if(m === 0){ m = 12; y -= 1; }
    if(y < earliestYear) break;
  }

  const optionsHtml = months.map((mo, i) =>
    `<option value="${mo.year}-${mo.month}"${i === 0 ? ' selected' : ''}>${mo.year}年${mo.month}月20日締め</option>`
  ).join('');
  el.innerHTML =
    `<button type="button" class="monthNavBtn" id="${prefix}-monthPrev" aria-label="前の月">◀</button>` +
    `<select id="${prefix}-monthSelect">${optionsHtml}</select>` +
    `<button type="button" class="monthNavBtn" id="${prefix}-monthNext" aria-label="次の月">▶</button>`;

  const sel = document.getElementById(`${prefix}-monthSelect`);
  const prevBtn = document.getElementById(`${prefix}-monthPrev`);
  const nextBtn = document.getElementById(`${prefix}-monthNext`);

  const updateNavButtons = () => {
    // options配列は先頭(index 0)が最新月、末尾が最古月の順
    nextBtn.disabled = sel.selectedIndex <= 0;
    prevBtn.disabled = sel.selectedIndex >= sel.options.length - 1;
  };
  const step = delta => {
    sel.selectedIndex += delta;
    updateNavButtons();
    triggerRecompute(prefix);
  };

  sel.addEventListener('change', () => { updateNavButtons(); triggerRecompute(prefix); });
  prevBtn.addEventListener('click', () => step(1));
  nextBtn.addEventListener('click', () => step(-1));
  updateNavButtons();
}

function getR4Month(){
  const sel = document.getElementById('r4-monthSelect');
  if(!sel || !sel.value) return currentClosingMonth_();
  const [y, m] = sel.value.split('-').map(Number);
  return { year: y, month: m };
}

/* 拠点・部署の並び順(数字が小さいほど優先) */
const R4_FACTORY_RANK = { '本社': 0, '夢前': 1, '鳥取': 2 };
const R4_DEPT_RANK = { '設計管理': 0, '工場': 1 }; /* 事務(内部値は設計管理)を優先 */

/* 指定日が終日「有給」または「欠勤」の対象かどうか(半日有給・遅早等は対象外) */
function fullDayLeaveType(operatorNo, dateStr){
  for(let i = 0; i < ABSENTEEISM.length; i++){
    const a = ABSENTEEISM[i];
    if(a.operatorNo === operatorNo && dateStr >= a.from && dateStr <= a.to &&
       (a.type === '有給' || a.type === '欠勤')) return a.type;
  }
  return null;
}

/* 指定日にAbsenteeismの届出(種別問わず)があるかどうか */
function hasAnyLeave(operatorNo, dateStr){
  return ABSENTEEISM.some(a => a.operatorNo === operatorNo && dateStr >= a.from && dateStr <= a.to);
}

/* 指定日のAbsenteeism届出(種別問わず)の種別テキストを返す(未来日の表示用)。なければnull */
function anyLeaveTypeText(operatorNo, dateStr){
  for(let i = 0; i < ABSENTEEISM.length; i++){
    const a = ABSENTEEISM[i];
    if(a.operatorNo === operatorNo && dateStr >= a.from && dateStr <= a.to) return a.type;
  }
  return null;
}

/* 未来日セル表示用の略称(2〜3文字)。一覧にない種別は先頭2文字にフォールバックする */
const R4_LEAVE_TYPE_ABBR = {
  '有給': '有給', '欠勤': '欠勤',
  '午前有給': '前有給', '午後有給': '後有給',
  '午前欠勤': '前欠勤', '午後欠勤': '後欠勤',
  '代休': '代休'
};
function r4LeaveAbbr_(type){
  return R4_LEAVE_TYPE_ABBR[type] || type.slice(0, 2);
}

function computeR4Grid(){
  const month = getR4Month();
  const range = closingRangeDates(month.year, month.month);
  const dates = [];
  for(let d = new Date(range.start); d <= range.end; d.setDate(d.getDate() + 1)){
    dates.push(new Date(d));
  }
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);

  const dateHeaders = dates.map(d => {
    const ds = `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
    return {
      date: ds,
      shortDate: `${d.getMonth()+1}/${d.getDate()}`,
      weekday: R4_WEEKDAY_NAMES[d.getDay()],
      holiday: CALENDAR_MAP[ds] === '休日',
      isPast: d < todayMidnight
    };
  });

  const locs = checkedValues('r4-locations');
  const depts = checkedValues('r4-depts');
  /* 日報入力チェックは在職中の社員のみ表示する(ユーザー指定)。退職済・休職中はもちろん、
     社員マスタの「Reportcheck」列に役職名(「専務」等)が入っているなど「在職中」以外の
     値を持つ社員も対象外になる(MASTER.operators[].activeで判定)。 */
  const operators = MASTER.operators
    .filter(o => o.active && locs.indexOf(o.factory) !== -1 && depts.indexOf(o.dept) !== -1)
    .slice()
    .sort((a, b) => Number(a.no) - Number(b.no));

  const totals = {};
  ALL_ROWS.forEach(r => {
    const key = r.operatorNo + '|' + r.workDate;
    totals[key] = (totals[key] || 0) + r.hours;
  });

  const allRows = operators.map(op => {
    const cells = dateHeaders.map(dh => {
      if(!dh.isPast){
        /* 未来日は未提出でもNG(missing)にはしない。ただし既にAbsenteeismの届出が
           あれば、種別テキストの先頭2文字をそのセルに表示し、既存の「leave」配色
           (薄黄色)を流用して何の届が出ているか分かるようにする。 */
        const futureLeave = anyLeaveTypeText(op.no, dh.date);
        if(futureLeave) return { value: null, text: r4LeaveAbbr_(futureLeave), flag: 'leave' };
        return { value: null, flag: '' };
      }
      const hours = totals[op.no + '|' + dh.date] || 0;
      const leave = fullDayLeaveType(op.no, dh.date);
      let flag = '';
      if(leave && hours > 0) flag = 'duplicate';
      else if(hours >= 16) flag = 'long';
      else if(!dh.holiday && !leave && hours === 0) flag = 'missing';
      else if(!dh.holiday && hasAnyLeave(op.no, dh.date)) flag = 'leave';
      return { value: hours > 0 ? hours : null, flag: flag };
    });
    const total = cells.reduce((s, c) => s + (c.value || 0), 0);

    return {
      no: op.no, name: op.name, factory: op.factory, dept: op.dept,
      cells: cells, total: total,
      hasNg: cells.some(c => c.flag === 'missing' || c.flag === 'duplicate' || c.flag === 'long')
    };
  });

  return { dateHeaders: dateHeaders, allRows: allRows };
}

/* 空セル配列(dateHeaders分)を作る */
function r4ZeroCells(n){
  return Array.from({length: n}, () => 0);
}

/* allRows(NGだけ表示フィルタ適用済み)を 拠点→部署(事務/工場) の階層にまとめ、
   各グループの見出し・小計、拠点合計、総合計を計算する */
function buildR4Groups(dateHeaders, filteredRows){
  const n = dateHeaders.length;
  const locGroups = [];
  let grandCells = r4ZeroCells(n);
  let grandTotal = 0;

  FACTORY_ORDER.forEach(loc => {
    const locRows = filteredRows.filter(r => r.factory === loc);
    if(locRows.length === 0) return;

    const deptGroups = [];
    [{ key: '設計管理', label: '事務' }, { key: '工場', label: '工場' }].forEach(d => {
      const rows = locRows.filter(r => r.dept === d.key);
      if(rows.length === 0) return;
      const subtotalCells = r4ZeroCells(n);
      rows.forEach(r => r.cells.forEach((c, i) => { subtotalCells[i] += (c.value || 0); }));
      const subtotalTotal = subtotalCells.reduce((s, v) => s + v, 0);
      deptGroups.push({ deptLabel: d.label, deptKey: d.key, rows: rows, subtotalCells: subtotalCells, subtotalTotal: subtotalTotal });
    });
    if(deptGroups.length === 0) return;

    const locCells = r4ZeroCells(n);
    deptGroups.forEach(g => g.subtotalCells.forEach((v, i) => { locCells[i] += v; }));
    const locTotal = locCells.reduce((s, v) => s + v, 0);
    locCells.forEach((v, i) => { grandCells[i] += v; });
    grandTotal += locTotal;

    locGroups.push({ location: loc, deptGroups: deptGroups, totalCells: locCells, total: locTotal });
  });

  return { locGroups: locGroups, grandCells: grandCells, grandTotal: grandTotal };
}

let r4NgOnly = false;

function toggleR4NgOnly(){
  r4NgOnly = !r4NgOnly;
  document.getElementById('r4-ngonly-btn').classList.toggle('active', r4NgOnly);
  withRecalcPopup(renderR4Preview);
}

function r4FlagClass(flag, holiday){
  if(flag) return 'r4' + flag.charAt(0).toUpperCase() + flag.slice(1);
  return holiday ? 'r4HolidayCol' : '';
}

function r4EmployeeRowHtml(r, dateHeaders){
  const tds = r.cells.map((c, i) =>
    `<td class="num r4DateCell ${c.text ? 'r4LeaveText' : ''} ${r4FlagClass(c.flag, dateHeaders[i].holiday)}">${c.text ? c.text : (c.value === null ? '' : c.value)}</td>`
  ).join('');
  return `<tr><td class="r4NameCol">${r.name}</td>${tds}<td class="num r4TotalCol">${r.total ? r.total : ''}</td></tr>`;
}

/* dateHeadersを渡し、休日の列だけr4HolidayColを付けて日付ごとに色分けする
   (合計・小計・拠点合計・総合計の行でも、その日が休日なら休日色にするため) */
function r4AggregateRowHtml(label, cells, total, rowClass, dateHeaders){
  const tds = cells.map((v, i) =>
    `<td class="num r4DateCell ${dateHeaders[i].holiday ? 'r4HolidayCol' : ''}">${v ? v : ''}</td>`
  ).join('');
  return `<tr class="${rowClass}"><td class="r4NameCol">${label}</td>${tds}<td class="num r4TotalCol">${total ? total : ''}</td></tr>`;
}

/* 拠点(本社/夢前/鳥取)・部署(工場/事務)の見出し行。休日の列だけ休日色にするため
   日付ごとのセルに分割している(見た目上はrowClass側の背景色で1色の帯に見える)。 */
function r4HeadRowHtml(label, dateHeaders, rowClass){
  const dateTds = dateHeaders.map(dh =>
    `<td class="r4DateCell ${dh.holiday ? 'r4HolidayCol' : ''}"></td>`
  ).join('');
  return `<tr class="${rowClass}"><td class="r4NameCol">${label}</td>${dateTds}<td class="r4TotalCol"></td></tr>`;
}

function r4BuildTableHtml(dateHeaders, groups){
  const headHtml = '<tr><th class="r4NameCol">氏名</th>' + dateHeaders.map(dh =>
    `<th class="r4DateCell ${dh.holiday ? 'r4HolidayCol' : ''}">${dh.shortDate}<br>${dh.weekday}</th>`
  ).join('') + '<th class="r4TotalCol">合計</th></tr>';

  let bodyHtml = '';
  groups.locGroups.forEach(loc => {
    bodyHtml += r4HeadRowHtml(loc.location, dateHeaders, 'r4LocHead');
    loc.deptGroups.forEach(dg => {
      bodyHtml += r4HeadRowHtml(dg.deptLabel, dateHeaders, 'r4DeptHead');
      dg.rows.forEach(r => { bodyHtml += r4EmployeeRowHtml(r, dateHeaders); });
      const subRowClass = dg.deptKey === '設計管理' ? 'r4SubtotalOffice' : 'r4SubtotalFactory';
      bodyHtml += r4AggregateRowHtml(dg.deptLabel + ' 小計', dg.subtotalCells, dg.subtotalTotal, subRowClass, dateHeaders);
    });
    bodyHtml += r4AggregateRowHtml(loc.location + ' 合計', loc.totalCells, loc.total, 'r4LocTotal', dateHeaders);
  });
  bodyHtml += r4AggregateRowHtml('総合計', groups.grandCells, groups.grandTotal, 'r4GrandTotal', dateHeaders);

  return `<table class="dataTable r4Table">${headHtml}${bodyHtml}</table>`;
}

function renderR4Preview(){
  const previewEl = document.getElementById('r4-preview');
  const grid = computeR4Grid();
  const rows = r4NgOnly ? grid.allRows.filter(r => r.hasNg) : grid.allRows;
  const month = getR4Month();

  if(rows.length === 0){
    previewEl.innerHTML = `<h3>プレビュー(社員別 提出チェック)</h3><div class="previewEmpty">該当する社員がいません</div>`;
    return;
  }

  const groups = buildR4Groups(grid.dateHeaders, rows);
  const range = closingRange(month.year, month.month);
  const fileName = `日報入力チェック_${range.start.split('/').join('-')}-${range.end.split('/').join('-')}_${today_()}.xlsx`;

  // ファイル名・見出しは previewEl の外（集計条件パネル直下のsticky要素）として作成
  const screenEl = document.querySelector('#screen-report4 .main');
  if(screenEl){
    let fileHeader = screenEl.querySelector('.r4FileHeader');
    if(!fileHeader){
      fileHeader = document.createElement('div');
      fileHeader.className = 'r4FileHeader';
      screenEl.insertBefore(fileHeader, previewEl);
    }
    fileHeader.innerHTML = `
      <div class="fileNamePreview">ファイル名: ${fileName}</div>
      <h3>プレビュー(社員別 提出チェック) — ${month.year}年${month.month}月20日締め</h3>`;
  }

  // previewEl には表だけを入れる
  previewEl.innerHTML = r4BuildTableHtml(grid.dateHeaders, groups);
  applyCellTooltips(previewEl.querySelector('.dataTable'));
  adjustR4StickyOffset_();
}

/* 集計条件パネル・ファイル名/見出し・表のth・氏名列(left固定)を、
   すべて.main(スクロール領域)の内側で一続きのsticky積み重ねにするための
   位置合わせ。集計条件パネルとファイル名/見出しの高さはフィルタの折り返し等で
   変わりうるため、都度実測してtopを設定する(ハードコードしない)。 */
function adjustR4StickyOffset_(){
  const table = document.querySelector('#r4-preview table.r4Table');
  const mainEl = table ? table.closest('.main') : null;
  if(!table || !mainEl) return;

  const mainPaddingLeft = parseFloat(getComputedStyle(mainEl).paddingLeft) || 0;
  const mainPaddingRight = parseFloat(getComputedStyle(mainEl).paddingRight) || 0;
  const mainPaddingTop = parseFloat(getComputedStyle(mainEl).paddingTop) || 0;

  /* 氏名列（left固定）のオフセット設定。
     横スクロール時に左に隙間ができないよう、mainのpadding-left分だけ
     leftを負の値で設定する。 */
  table.querySelectorAll('.r4NameCol').forEach(cell => {
    cell.style.left = (-mainPaddingLeft) + 'px';
  });

  /* updateR4HStuckState_内で参照するため、データ属性に保存。 */
  table.dataset.mainPaddingLeft = mainPaddingLeft;

  /* 集計条件パネル・ファイル名/見出しは、mainのpadding-left/rightを
     margin相殺(負のmargin)+width:autoで打ち消し、常に.mainの見えている
     横幅ぴったりまで広げる(表の幅がいくつでも計算し直さずに済む)。
     横スクロールへの追従はCSSのsticky(left)には任せない。要素の幅が
     .mainの内側(padding抜き)の幅よりはみ出す関係で、ネイティブのsticky(left)
     はスクロール範囲の途中〜終端にかけて中途半端な位置で止まってしまう
     不具合があったため、代わりにupdateR4HStuckState_内でスクロール量を
     transform:translateXで直接打ち消し、常に画面左端に揃える(氏名列と
     同じ結果になるよう実測して確認済み)。 */
  const panelEl = mainEl.querySelector('.r4StickyPanel');
  const fileHeaderEl = mainEl.querySelector('.r4FileHeader');
  const backdropEl = mainEl.querySelector('.r4HeaderBackdrop');
  /* 右端は実測値ぴったりだと誤差で表のセルが覗くことがあるため、
     少し多めに覆う方向にバッファを持たせる(白い箱がほんの数px
     余分に大きくなるだけで見た目には影響しない)。 */
  const R4_STICKY_H_BUFFER = 4;
  [panelEl, fileHeaderEl, backdropEl].forEach(el => {
    if(!el) return;
    el.style.marginLeft = (-mainPaddingLeft) + 'px';
    el.style.marginRight = (-(mainPaddingRight + R4_STICKY_H_BUFFER)) + 'px';
    el.style.width = 'auto';
  });

  /* 集計条件パネル(top:0)の直下にファイル名/見出しを、さらにその直下に
     表のth(氏名・日付行)を積み重ねる。それぞれの実測高さを積算してtopに
     設定することで、フィルタの折り返し行数が変わっても正しく追従する。
     端数px(サブピクセル)のまま設定すると、ズーム率等によっては丸め誤差で
     1px未満の継ぎ目ができうるため、切り上げて整数pxにする(覆う側が
     わずかに広くなる方向に丸めることで、隙間ではなく重なりにする)。 */
  const panelHeight = panelEl ? Math.ceil(panelEl.getBoundingClientRect().height) : 0;
  if(fileHeaderEl) fileHeaderEl.style.top = panelHeight + 'px';
  const fileHeaderHeight = fileHeaderEl ? Math.ceil(fileHeaderEl.getBoundingClientRect().height) : 0;

  const theadTop = panelHeight + fileHeaderHeight;
  const firstThRow = table.querySelector('tr');
  if(firstThRow) {
    firstThRow.querySelectorAll('th').forEach(th => {
      th.style.top = theadTop + 'px';
    });
  }
  const theadHeight = firstThRow ? Math.ceil(firstThRow.getBoundingClientRect().height) : 0;

  /* 背景板(r4HeaderBackdrop)は集計条件パネル・ファイル名見出し・氏名/日付行を
     合わせた高さぶん、薄黄色(.mainと同じ色)で覆う。3要素の継ぎ目に多少の
     実測誤差があっても、そこには表のセルではなく背景板の色が見えるだけになり、
     表のセルが上に覗くことはなくなる。
     さらに、.mainのpadding-top(appHeaderの下端と背景板/パネルの間にできる
     隙間の原因)分も覆うよう、sticky要素の実際の固定位置を決める"top"
     プロパティ自体を負の値にして食い込ませる(margin-topではsticky時の
     固定位置は動かない。stickyの固定位置は常にtopプロパティで決まり、
     marginは通常フロー上の占有スペースにのみ影響するため)。
     topオフセット自体は通常フロー上の占有スペースに影響しないため、
     増えた高さ(mainPaddingTop分)だけをmargin-bottomで相殺すればよい。 */
  if(backdropEl){
    const restHeight = panelHeight + fileHeaderHeight + theadHeight;
    const backdropHeight = mainPaddingTop + restHeight;
    backdropEl.style.top = (-mainPaddingTop) + 'px';
    backdropEl.style.height = backdropHeight + 'px';
    backdropEl.style.marginBottom = (-backdropHeight) + 'px';
  }

  /* 氏名列の横スクロール時の背景隙間対策（box-shadow）。 */
  updateR4HStuckState_(mainEl);

  /* スクロールリスナー（1回だけ登録）。 */
  if(!mainEl._r4StuckListenerAttached){
    mainEl._r4StuckListenerAttached = true;
    mainEl.addEventListener('scroll', () => {
      updateR4HStuckState_(mainEl);
    });
  }

  /* 集計条件パネル・ファイル名見出し・氏名/日付行の高さは、フォント読み込み
     完了等のタイミングによって実測後に変わることがある。ResizeObserverで
     実際の高さの変化を監視し、変わるたびにこの関数を再実行して背景板の高さ・
     th/ファイル名見出しのtop位置を自動で追従させる(測定タイミングのズレに
     左右されないようにするため)。表は再描画のたびに要素が作り直されるため、
     firstThRowは毎回observeし直す(既にobserve済みの要素への再呼び出しは
     何も起きない安全な操作)。 */
  if(!mainEl._r4ResizeObserver){
    mainEl._r4ResizeObserver = new ResizeObserver(() => adjustR4StickyOffset_());
  }
  if(panelEl) mainEl._r4ResizeObserver.observe(panelEl);
  if(fileHeaderEl) mainEl._r4ResizeObserver.observe(fileHeaderEl);
  if(firstThRow) mainEl._r4ResizeObserver.observe(firstThRow);
}

/* 氏名列(.r4NameCol)が実際に横方向へ貼り付いている(stuck)かどうかを
   ヘッダーセル(th.r4NameCol)の現在位置から判定する。
   【重要】table-cell要素はCSS仕様上marginを無視するため、当初試した
   「margin-leftで箱を広げてpadding-leftで押し戻す」方式は機能しなかった
   (marginが無視され、padding-leftによる拡張分だけセル自体が実際に
   ワイダーになってしまい、氏名列全体の幅が変わって以降の列がズレる・
   表全体の幅が変わってしまうという不具合を起こした)。
   代わりにbox-shadow(レイアウトに一切影響しない純粋な描画effect)を使い、
   隙間の位置に「そのセルの実際の背景色と同じ色の帯」を描画するだけに
   している。box-shadowはセル自身の幅・位置を一切変えないため、表の
   横幅や以降の列の位置には影響しない。 */
function updateR4HStuckState_(mainEl){
  const table = document.querySelector('#r4-preview table.r4Table');
  if(!table) return;
  const mainPaddingLeft = parseFloat(table.dataset.mainPaddingLeft || '0');
  const headerCell = table.querySelector('th.r4NameCol');
  if(!headerCell) return;
  const mainLeft = mainEl.getBoundingClientRect().left;
  const cellLeft = headerCell.getBoundingClientRect().left;
  const stuck = cellLeft <= (mainLeft + 1);
  table.querySelectorAll('.r4NameCol').forEach(cell => {
    if(stuck){
      const bg = getComputedStyle(cell).backgroundColor;
      cell.style.boxShadow = (-mainPaddingLeft) + 'px 0 0 0 ' + bg;
    } else {
      cell.style.boxShadow = '';
    }
  });

  /* 集計条件パネル・ファイル名見出し・背景板は、.mainの横スクロール量を
     そのままtransform:translateXで打ち消して常に画面左端に揃える(氏名列と
     同じ見え方になるよう実測して確認済み)。 */
  const tx = mainEl.scrollLeft + 'px';
  const panelEl = mainEl.querySelector('.r4StickyPanel');
  const fileHeaderEl = mainEl.querySelector('.r4FileHeader');
  const backdropEl = mainEl.querySelector('.r4HeaderBackdrop');
  if(panelEl) panelEl.style.transform = 'translateX(' + tx + ')';
  if(fileHeaderEl) fileHeaderEl.style.transform = 'translateX(' + tx + ')';
  if(backdropEl) backdropEl.style.transform = 'translateX(' + tx + ')';
}

/* ===================== リセットボタン ===================== */

/* 「指定:しない/する」トグルを「しない」に戻す(chipSearch/checkGroupのリセットとは別) */
function resetSpecToggle(specName){
  const radios = document.querySelectorAll(`input[name="${specName}"]`);
  radios.forEach(r => r.closest('.specBtn').classList.remove('checked'));
  const noRadio = document.querySelector(`input[name="${specName}"][value="no"]`);
  noRadio.checked = true;
  noRadio.closest('.specBtn').classList.add('checked');
  const body = noRadio.closest('.field').querySelector('.specBody');
  if(body) body.classList.remove('open');
}

/* チップ選択と検索欄をクリア */
function resetCheckGroup(groupId){
  const groupEl = document.getElementById(groupId);
  groupEl.querySelectorAll('input[type=checkbox]').forEach(cb=>{
    cb.checked = false;
    cb.closest('.checkBtn').classList.remove('checked');
  });
  const searchInput = groupEl.closest('.field').querySelector('.chipSearch');
  if(searchInput){
    searchInput.value = '';
    searchQueries[groupId] = '';
    applyChipVisibility(groupId);
  }
}

function resetScreen(prefix){
  if(prefix === 'r1' || prefix === 'r2'){
    const cfg = SCREEN_CONFIG[prefix];
    document.getElementById(cfg.primary.id).value = '';
    cfg.dims.forEach(dim=>{
      resetSpecToggle(dim.specName);
      resetCheckGroup(dim.groupId);
    });
    resetSpecToggle(cfg.periodSpecName);
    buildPeriodPicker(`${prefix}-period`, prefix); // 年/月/モード/自由日付を初期値に再構築(内部でrecomputeも走る)
    applyDefaultFactoryFilter_(prefix); // 工場フィルタはログイン時に選択した工場に戻す(「しない」には戻さない)
    recomputeScreen(prefix);
  } else if(prefix === 'r3'){
    applyDefaultFactoryFilter_('r3'); // ログイン時に選択した工場のみチェックに戻す(全拠点チェックには戻さない)
    buildClosingOnlyPicker('r3-period', 'r3'); // 締め年/月を初期値に再構築(内部でrenderR3Previewも走る)
  } else if(prefix === 'r4'){
    applyDefaultFactoryFilter_('r4'); // ログイン時に選択した工場のみチェックに戻す(全拠点チェックには戻さない)
    document.querySelectorAll('#r4-depts input[type=checkbox]').forEach(cb => {
      cb.checked = true;
      cb.closest('.checkBtn').classList.add('checked');
    });
    r4NgOnly = false;
    document.getElementById('r4-ngonly-btn').classList.remove('active');
    buildMonthPicker('r4-month', 'r4'); // 締め月を最新(先頭)に戻す
    withRecalcPopup(renderR4Preview);
  }
}

/* ===================== ダウンロードボタン(実データ・実API) ===================== */

/* サーバーに送るのは既にクライアント側で絞り込み済みの行だけ(_dateを除いた
   プレーンなオブジェクト)。Code.gs側のgenerateReport1〜4はこの前提で
   再フィルタを行わない設計になっている(引き継ぎ書■6参照)。 */
function stripDate_(rows){
  return rows.map(r => ({
    operatorNo: r.operatorNo, factory: r.factory, dept: r.dept,
    workDate: r.workDate, constructionId: r.constructionId, workCode: r.workCode, hours: r.hours
  }));
}

function buildReportParams_(kind){
  if(kind === 'r1'){
    const rows = filteredRows(SCREEN_CONFIG.r1, null);
    return {
      rows: stripDate_(rows),
      constructionId: document.getElementById('r1-construction').value,
      locSpec: document.querySelector('input[name="r1-loc-spec"]:checked').value,
      locs: checkedValues('r1-loc'),
      periodSpec: document.querySelector('input[name="r1-period-spec"]:checked').value,
      periodMode: document.querySelector('input[name="r1mode"]:checked').value,
      year: document.getElementById('r1-year').value,
      month: document.getElementById('r1-month').value,
      from: document.getElementById('r1-from').value,
      to: document.getElementById('r1-to').value
    };
  }
  if(kind === 'r2'){
    const rows = filteredRows(SCREEN_CONFIG.r2, null);
    return {
      rows: stripDate_(rows),
      operatorNo: document.getElementById('r2-operator').value,
      periodSpec: document.querySelector('input[name="r2-period-spec"]:checked').value,
      periodMode: document.querySelector('input[name="r2mode"]:checked').value,
      year: document.getElementById('r2-year').value,
      month: document.getElementById('r2-month').value,
      from: document.getElementById('r2-from').value,
      to: document.getElementById('r2-to').value
    };
  }
  if(kind === 'r3'){
    const locs = checkedValues('r3-locations');
    const year = Number(document.getElementById('r3-year').value);
    const month = Number(document.getElementById('r3-month').value);
    const range = closingRangeDates(year, month);
    const periodRows = ALL_ROWS.filter(r => r._date >= range.start && r._date <= range.end);
    return { rows: stripDate_(periodRows), locs: locs, year: year, month: month };
  }
  if(kind === 'r4'){
    const grid = computeR4Grid();
    const rows = r4NgOnly ? grid.allRows.filter(r => r.hasNg) : grid.allRows;
    const month = getR4Month();
    const range = closingRange(month.year, month.month);
    const rangeToken = `${range.start.split('/').join('-')}-${range.end.split('/').join('-')}`;
    return { dateHeaders: grid.dateHeaders, rows: rows, rangeToken: rangeToken };
  }
  return null;
}

function downloadFileBase64_(base64, fileName, mimeType) {
  const byteChars = atob(base64);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
  const blob = new Blob([new Uint8Array(byteNumbers)], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const REPORT_ACTION = { r1: 'generateReport1', r2: 'generateReport2', r3: 'generateReport3', r4: 'generateReport4' };

async function downloadReport(kind){
  if(kind === 'r1' && !document.getElementById('r1-construction').value){ showToast('工事を選択してください'); return; }
  if(kind === 'r2' && !document.getElementById('r2-operator').value){ showToast('社員を選択してください'); return; }
  if(kind === 'r3' && checkedValues('r3-locations').length === 0){ showToast('拠点を1つ以上選択してください'); return; }
  if(kind === 'r4'){
    const grid = computeR4Grid();
    const rows = r4NgOnly ? grid.allRows.filter(r => r.hasNg) : grid.allRows;
    if(rows.length === 0){ showToast('該当する社員がいません'); return; }
  }

  const params = buildReportParams_(kind);
  const startedAt = showFakeProgress('情報収集中', FAKE_PROGRESS_DURATION_MS, false);
  try {
    const result = await apiPost(REPORT_ACTION[kind], params);
    hideFakeProgress(startedAt, () => {
      downloadFileBase64_(result.base64, result.fileName, result.mimeType);
      showToast('Excelファイルをダウンロードしました');
    });
  } catch (err) {
    hideFakeProgress(startedAt, () => {
      showToast('ダウンロードに失敗しました: ' + err.message);
    });
  }
}

/* ===================== 情報収集中ポップアップ ===================== */
/* 実際の待ち時間とは連動しない演出用。show時刻を返し、hide側で最低表示時間を保証する。
   実際の処理がそれより長くかかった場合は、実際に終わるまでポップアップを表示し続ける。 */
const FAKE_PROGRESS_DURATION_MS = 15000;
let fakeProgressTimer = null;

function showFakeProgress(label, durationMs, showWarning){
  const overlay = document.getElementById('fakeProgressOverlay');
  const fill = document.getElementById('fakeProgressFill');
  const warning = document.getElementById('fakeProgressWarning');
  document.getElementById('fakeProgressLabel').textContent = label || '情報収集中';
  warning.style.display = showWarning ? 'block' : 'none';
  if(fakeProgressTimer) clearInterval(fakeProgressTimer);
  fill.style.width = '0%';
  overlay.classList.add('show');
  const startedAt = Date.now();
  const duration = durationMs || FAKE_PROGRESS_DURATION_MS;
  fakeProgressTimer = setInterval(() => {
    const pct = Math.min(100, ((Date.now() - startedAt) / duration) * 100);
    fill.style.width = pct + '%';
    if(pct >= 100 && fakeProgressTimer){ clearInterval(fakeProgressTimer); fakeProgressTimer = null; }
  }, 100);
  return startedAt;
}

function hideFakeProgress(startedAt, callback){
  const remaining = Math.max(0, FAKE_PROGRESS_DURATION_MS - (Date.now() - startedAt));
  setTimeout(() => {
    document.getElementById('fakeProgressOverlay').classList.remove('show');
    if(fakeProgressTimer){ clearInterval(fakeProgressTimer); fakeProgressTimer = null; }
    if(callback) callback();
  }, remaining);
}

/* 初回押下時専用: 実データ取得が完了した時点でバーを即100%にしてポップアップを閉じる(最低表示時間を待たない) */
function hideFakeProgressNow(callback){
  const fill = document.getElementById('fakeProgressFill');
  fill.style.width = '100%';
  if(fakeProgressTimer){ clearInterval(fakeProgressTimer); fakeProgressTimer = null; }
  setTimeout(() => {
    document.getElementById('fakeProgressOverlay').classList.remove('show');
    if(callback) callback();
  }, 300);
}

/* ===================== 初期化 ===================== */

document.getElementById('r1-construction').addEventListener('change', () => recomputeScreen('r1'));
document.getElementById('r2-operator').addEventListener('change', () => recomputeScreen('r2'));

// プレビュー表(①②③④共通)のセルクリック(タップ)で、はみ出した全文を
// クリックしたセルの右上にポップアップ表示する。
// 個別セルへのリスナーだと再描画のたびに失われるため、documentに1つだけ委譲で登録する。
document.addEventListener('click', e => {
  const cell = e.target.closest('table.dataTable td, table.dataTable th');
  if(cell){
    if(cell.scrollWidth > cell.clientWidth) showCellTextPopup(cell);

    // ①日報入力チェックのみ: クリックした行を二重線でハイライトする(常に1行だけ)
    const r4Table = cell.closest('table.r4Table');
    if(r4Table && cell.tagName === 'TD'){
      r4Table.querySelectorAll('tr.r4RowSelected').forEach(tr => tr.classList.remove('r4RowSelected'));
      cell.closest('tr').classList.add('r4RowSelected');
    }
  }
});

buildPeriodPicker('r1-period','r1');
buildPeriodPicker('r2-period','r2');
buildClosingOnlyPicker('r3-period','r3');
buildMonthPicker('r4-month','r4');

// ブラウザを閉じずに再読み込みした場合、ロック解除・工場選択済みならホーム画面へ直行する
if(sessionStorage.getItem('unlocked') === '1' && getDefaultFactory_()){
  applyDefaultFactoryToAllScreens_();
  updateHeaderFactoryLabels_();
  showScreen('home');
  initSyncPopup();
}
