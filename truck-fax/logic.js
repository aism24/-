/* 車番連絡FAX取込の純粋ロジック(画面・テスト共通。DOM・通信は使わない)
 * - 表記ゆれの正規化(車番・電話・会社名・氏名・日付・時刻)
 * - Gemini読み取り結果の整形(sanitizeOcr)
 * - マスタ(車両情報・運転手携帯番号)との照合(evaluateBatch)と、確認結果の反映(resolveRow)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TruckLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 正規化 ----------
  function nfkc(s) { return String(s == null ? '' : s).normalize('NFKC'); }
  function compact(s) { return nfkc(s).replace(/[\s　]+/g, ''); }
  function clean(s) { return nfkc(s).replace(/[\s　]+/g, ' ').trim(); }
  /** 記録用: 空白の整理だけ(㈱などFAXの表記は変えない。照合は別に正規化する)。 */
  function tidy(s) { return String(s == null ? '' : s).replace(/[\s\u3000]+/g, ' ').trim(); }

  function plateKey(s) { return compact(s).replace(/[-‐-―−ー・.]/g, '').toLowerCase(); }
  function fmtPlate(s) { return compact(s); }
  function companyKey(s) {
    return compact(s).replace(/\(株\)|\(有\)|\(合\)|\(同\)|株式会社|有限会社|合同会社/g, '').replace(/[()・]/g, '').toLowerCase();
  }
  function nameKey(s) { return compact(s); }
  function typeKey(s) { return compact(s).toLowerCase(); }
  function phoneDigits(s) { return nfkc(s).replace(/\D/g, ''); }
  function fmtPhone(s) {
    var d = phoneDigits(s);
    if (d.length === 11) return d.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3');
    if (d.length === 10) return /^0[36]/.test(d) ? d.replace(/(\d{2})(\d{4})(\d{4})/, '$1-$2-$3') : d.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
    return clean(s);
  }
  function isMobile(d) { return /^0[789]0\d{8}$/.test(d); }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  /** 'yyyy/MM/dd' に整える。年が無いときは refYear を使う。読めなければ ''。 */
  function normDate(s, refYear) {
    var t = nfkc(s).trim();
    var y, m, d, a;
    if ((a = /^(\d{4})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})/.exec(t))) { y = +a[1]; m = +a[2]; d = +a[3]; }
    else if ((a = /^(\d{1,2})[\/月](\d{1,2})/.exec(t))) { y = refYear; m = +a[1]; d = +a[2]; }
    else return '';
    var dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return '';
    return y + '/' + pad2(m) + '/' + pad2(d);
  }
  function normTime(s) {
    var t = nfkc(s).replace(/[着頃]/g, '').trim();
    var a = /(\d{1,2})\s*[:時]\s*(\d{1,2})?/.exec(t);
    if (!a) return t;
    return (+a[1]) + ':' + pad2(a[2] ? +a[2] : 0);
  }

  /** 工事一覧(情報シートG:H。[{工事番号, 工事名}])から工事番号で現場名を引く。無ければ ''。 */
  function projectName(projects, no) {
    var k = compact(no).toUpperCase();
    if (!k) return '';
    for (var i = 0; i < (projects || []).length; i++) if (compact(projects[i].工事番号).toUpperCase() === k) return projects[i].工事名;
    return '';
  }

  /** 過去の取込([{行先, 工事番号, 現場名}]。古い順)から、行先ごとに直近の工事番号を覚える。 */
  function buildDestMap(past) {
    var m = {};
    (past || []).forEach(function (p) {
      var k = compact(p.行先);
      if (k && compact(p.工事番号)) m[k] = { 工事番号: p.工事番号, 現場名: p.現場名 };
    });
    return m;
  }
  function suggestProject(map, dest) { return (map || {})[compact(dest)] || null; }

  function isTrue(v) { return v === true || /^(true|はい|yes|1)$/i.test(String(v == null ? '' : v).trim()); }
  /** FAXの区分: 新規 / 変更(再・訂正) / 追加(増車) / 取消。判断できなければ新規。 */
  function normKind(s) {
    var t = compact(s);
    if (/取消|取り消し|キャンセル/.test(t)) return '取消';
    if (/追加|増車/.test(t)) return '追加';
    if (/変更|訂正|再/.test(t)) return '変更';
    return '新規';
  }

  // ---------- Gemini読み取り結果の整形 ----------
  var ROW_FIELDS = ['工事番号', '現場名', '業者', '積日', '卸日', '行先', '着時間', '運送業者', '車種', '車番', '氏名', '携帯番号'];

  /** raw: Geminiが返したJSON(オブジェクト)。{業者, FAX日付, 明細:[{積日,卸日,行先,着時間,運送業者,車種,車番,氏名,携帯番号}]} */
  function sanitizeOcr(raw, opts) {
    var today = (opts && opts.today) || new Date();
    var warnings = [];
    raw = raw || {};
    var sender = tidy(raw['業者']);
    var kind = normKind(raw['区分']);
    var memo = tidy(raw['メモ']);
    var fax = normDate(raw['FAX日付'], today.getFullYear());
    var refYear = fax ? +fax.slice(0, 4) : today.getFullYear();
    if (!fax) warnings.push('FAXの日付を読み取れなかったため、今年を基準にしています。');
    if (!sender) warnings.push('FAXの送り主(業者)を読み取れませんでした。');
    var rows = [];
    (Array.isArray(raw['明細']) ? raw['明細'] : []).forEach(function (r) {
      r = r || {};
      var o = {
        工事番号: '',
        現場名: '',
        業者: sender,
        積日: normDate(r['積日'], refYear),
        卸日: normDate(r['卸日'], refYear),
        行先: tidy(r['行先']),
        着時間: normTime(r['着時間']),
        運送業者: tidy(r['運送業者']),
        車種: tidy(r['車種']).replace(/\s+/g, ''),
        車番: fmtPlate(r['車番']),
        氏名: nameKey(r['氏名']),
        携帯番号: fmtPhone(r['携帯番号']),
        struck: isTrue(r['取消線'])
      };
      if (!o.車番 && !o.氏名 && !o.携帯番号 && !o.運送業者) return; // 空欄行
      // 年またぎ(12月積み・1月卸し)
      if (o.積日 && o.卸日 && o.卸日 < o.積日) {
        var sm = +o.積日.slice(5, 7), dm = +o.卸日.slice(5, 7);
        if (sm >= 11 && dm <= 2) o.卸日 = normDate((+o.卸日.slice(0, 4) + 1) + o.卸日.slice(4), refYear);
      }
      rows.push(o);
    });
    if (!rows.length) warnings.push('明細(車両の行)を読み取れませんでした。');
    return { sender: sender, faxDate: fax, kind: kind, memo: memo, rows: rows, warnings: warnings };
  }

  // ---------- マスタ照合 ----------
  function push(map, k, v) { (map[k] = map[k] || []).push(v); }

  function indexMasters(vehicles, drivers) {
    var idx = { vByPlate: {}, dByKey: {}, dByPhone: {}, dByName: {} };
    vehicles.forEach(function (v) { var k = plateKey(v.車番); if (k) push(idx.vByPlate, k, v); });
    drivers.forEach(function (d) { addDriverIdx(idx, d); });
    return idx;
  }
  function addDriverIdx(idx, d) {
    push(idx.dByKey, companyKey(d.運送業者) + '|' + nameKey(d.氏名), d);
    var p = phoneDigits(d.携帯番号); if (p) push(idx.dByPhone, p, d);
    push(idx.dByName, nameKey(d.氏名), d);
  }

  function vehicleData(row) { return { 手配業者: row.業者, 運送業者: row.運送業者, 車種: row.車種, 車番: fmtPlate(row.車番) }; }
  function driverData(row) { return { 運送業者: row.運送業者, 氏名: nameKey(row.氏名), 携帯番号: fmtPhone(row.携帯番号) }; }
  function importKey(row) { return row.積日 + '|' + plateKey(row.車番); }
  function who(d) { return '「' + d.運送業者 + ' ' + d.氏名 + '(' + d.携帯番号 + ')」'; }

  var OPT = {
    register: { value: 'register', label: 'マスタに新規登録する' },
    skipReg: { value: 'skip', label: '登録しない' },
    update: { value: 'update', label: 'マスタを今回の値に更新する' },
    adopt: { value: 'adopt', label: '今回の取込をマスタの値に直す' },
    keep: { value: 'keep', label: '今回だけこの値で記録(マスタは変えない)' },
    ok: { value: 'ok', label: '確認した(このまま記録する)' },
    recordAgain: { value: 'record', label: '重複を承知で記録する' },
    skipRow: { value: 'skip', label: 'この行は記録しない' },
    newPerson: { value: 'new', label: '別人として新規登録する' }
  };

  /** 1行を照合して指摘(findings)を返す。idx は書き換える(同じFAX内の新規登録を後続行から見えるようにする)。 */
  function checkRow(row, idx, importKeys, seen) {
    var f = [];
    function add(id, level, title, detail, options, def) { f.push({ id: id, level: level, title: title, detail: detail || '', options: options || [], defaultValue: def == null ? null : def }); }

    var plate = plateKey(row.車番), name = nameKey(row.氏名), ck = companyKey(row.運送業者), phone = phoneDigits(row.携帯番号);

    if (!plate) add('missing-plate', 'error', '車番が空です', '車番を入力してください。');
    if (!row.積日 || !row.卸日) add('bad-date', 'error', '積日・卸日が読み取れていません', 'yyyy/mm/dd の形で入力してください。');
    if (!row.工事番号) add('missing-project', 'warn', '工事番号が未選択です', '表の「工事番号」で、行先「' + row.行先 + '」に対応する工事を選んでください。選んだ工事は、記録後、次回から同じ行先の初期値になります。', [{ value: 'ok', label: '工事番号なしで記録する' }]);
    if (!row.運送業者) add('missing-carrier', 'warn', '運送業者が空です', '', [OPT.ok]);
    if (!name) add('missing-name', 'warn', '氏名が空です', '', [OPT.ok]);
    if (!phone) add('missing-phone', 'warn', '携帯番号が空です', '', [OPT.ok]);
    else if (!isMobile(phone)) add('phone-format', 'warn', '携帯番号の形式が違います', '「' + row.携帯番号 + '」は携帯の番号(070/080/090 + 8桁)ではありません。読み間違いの可能性があります。', [OPT.ok]);

    // 車両
    if (plate) {
      var vs = idx.vByPlate[plate] || [];
      if (!vs.length) {
        add('vehicle-new', 'info', 'この車番は車両情報に未登録です', row.車番 + '(' + row.運送業者 + ')', [OPT.register, OPT.skipReg], 'register');
        push(idx.vByPlate, plate, vehicleData(row));
      } else {
        var m = vs[0], diffs = [];
        if (vs.length > 1) add('master-dup-vehicle', 'warn', '車両情報に同じ車番が' + vs.length + '件あります', '「車両情報」画面で整理してください。', [OPT.ok]);
        if (row.業者 && companyKey(row.業者) !== companyKey(m.手配業者)) diffs.push('手配業者: マスタ「' + m.手配業者 + '」/ 今回「' + row.業者 + '」');
        if (row.運送業者 && ck !== companyKey(m.運送業者)) diffs.push('運送業者: マスタ「' + m.運送業者 + '」/ 今回「' + row.運送業者 + '」');
        if (row.車種 && typeKey(row.車種) !== typeKey(m.車種)) diffs.push('車種: マスタ「' + m.車種 + '」/ 今回「' + row.車種 + '」');
        if (diffs.length) {
          var vf = { id: 'vehicle-diff', masterRow: m._row, masterData: m };
          add('vehicle-diff', 'warn', '車両情報と食い違っています(車番 ' + row.車番 + ')', diffs.join('\n'), [OPT.update, OPT.adopt, OPT.keep]);
          f[f.length - 1].masterRow = vf.masterRow; f[f.length - 1].masterData = m;
        }
      }
    }

    // 運転手
    if (name && row.運送業者) {
      var list = idx.dByKey[ck + '|' + name] || [];
      if (list.length) {
        var d0 = list[0];
        if (list.length > 1) add('master-dup-driver', 'warn', '運転手マスタに同じ氏名・運送業者が' + list.length + '件あります', '「運転手」画面で整理してください。', [OPT.ok]);
        if (phone && phoneDigits(d0.携帯番号) !== phone) {
          add('phone-diff', 'warn', '携帯番号がマスタと違います(' + row.氏名 + ')', 'マスタ: ' + d0.携帯番号 + ' / 今回: ' + row.携帯番号, [OPT.update, OPT.adopt, OPT.keep]);
          f[f.length - 1].masterRow = d0._row; f[f.length - 1].masterData = d0;
        }
        var others = phone ? (idx.dByPhone[phone] || []).filter(function (x) { return x !== d0 && !(nameKey(x.氏名) === name && companyKey(x.運送業者) === ck); }) : [];
        if (others.length) add('phone-shared', 'warn', 'この携帯番号は別の人にも登録されています', 'マスタ: ' + who(others[0]), [OPT.ok]);
      } else {
        var byPhone = phone ? (idx.dByPhone[phone] || []) : [];
        if (byPhone.length) {
          var o0 = byPhone[0];
          add('phone-owner-diff', 'warn', 'この携帯番号は、マスタでは別の氏名(または運送業者)です', 'マスタ: ' + who(o0) + '\n今回: 「' + row.運送業者 + ' ' + row.氏名 + '」\n氏名の変更・読み間違い・運送業者の変更の可能性があります。', [OPT.update, OPT.adopt, OPT.newPerson, OPT.keep]);
          f[f.length - 1].masterRow = o0._row; f[f.length - 1].masterData = o0;
        } else {
          var sameName = idx.dByName[name] || [];
          if (sameName.length) {
            add('name-other-carrier', 'warn', '同じ氏名が別の運送業者で登録されています', 'マスタ: ' + who(sameName[0]) + '\n今回: 「' + row.運送業者 + ' ' + row.氏名 + '」', [OPT.newPerson, OPT.keep]);
          } else if (phone) {
            add('driver-new', 'info', 'この運転手は運転手マスタに未登録です', row.運送業者 + ' ' + row.氏名 + '(' + row.携帯番号 + ')', [OPT.register, OPT.skipReg], 'register');
            addDriverIdx(idx, driverData(row));
          }
        }
      }
    }

    // 重複取込
    var ik = row.積日 && plate ? importKey(row) : '';
    if (ik) {
      if (importKeys[ik]) add('dup-import', 'warn', '同じ積日・車番が取込一覧に既にあります', row.積日 + ' ' + row.車番, [OPT.recordAgain, OPT.skipRow]);
      else if (seen[ik]) add('dup-import', 'warn', '同じFAX内(または同時に取り込んだ分)に、同じ積日・車番があります', row.積日 + ' ' + row.車番, [OPT.recordAgain, OPT.skipRow]);
      seen[ik] = true;
    }
    return f;
  }

  /** rows を順に照合。ctx: {vehicles, drivers, importKeys(配列)}。各行の指摘の配列を返す。 */
  function evaluateBatch(rows, ctx, preSeen) {
    var idx = indexMasters(ctx.vehicles || [], ctx.drivers || []);
    var keys = {}; (ctx.importKeys || []).forEach(function (k) { keys[k] = true; });
    var seen = preSeen || {};
    return rows.map(function (r) { return checkRow(r, idx, keys, seen); });
  }

  /** 確認結果(decisions: {指摘id: 選択値})を行に反映する。 */
  function resolveRow(row, findings, decisions) {
    var out = Object.assign({}, row);
    out.車番 = fmtPlate(out.車番); out.氏名 = nameKey(out.氏名); out.携帯番号 = fmtPhone(out.携帯番号);
    var ops = [], skip = false, blockers = [];
    findings.forEach(function (f) {
      var d = decisions && decisions[f.id] != null ? decisions[f.id] : f.defaultValue;
      if (f.level === 'error') { blockers.push(f.id); return; }
      if (d == null) { blockers.push(f.id); return; }
      var md = f.masterData;
      switch (f.id) {
        case 'vehicle-new': if (d === 'register') ops.push({ kind: 'vehicle', mode: 'add', data: vehicleData(out) }); break;
        case 'vehicle-diff':
          if (d === 'update') ops.push({ kind: 'vehicle', mode: 'update', row: f.masterRow, before: pick(md, ['手配業者', '運送業者', '車種', '車番']), data: { 手配業者: out.業者 || md.手配業者, 運送業者: out.運送業者 || md.運送業者, 車種: out.車種 || md.車種, 車番: out.車番 } });
          else if (d === 'adopt') { out.業者 = md.手配業者; out.運送業者 = md.運送業者; out.車種 = md.車種; }
          break;
        case 'phone-diff':
          if (d === 'update') ops.push({ kind: 'driver', mode: 'update', row: f.masterRow, before: pick(md, ['運送業者', '氏名', '携帯番号']), data: { 運送業者: md.運送業者, 氏名: md.氏名, 携帯番号: out.携帯番号 } });
          else if (d === 'adopt') out.携帯番号 = md.携帯番号;
          break;
        case 'phone-owner-diff':
          if (d === 'update') ops.push({ kind: 'driver', mode: 'update', row: f.masterRow, before: pick(md, ['運送業者', '氏名', '携帯番号']), data: driverData(out) });
          else if (d === 'adopt') { out.氏名 = md.氏名; out.運送業者 = md.運送業者; }
          else if (d === 'new') ops.push({ kind: 'driver', mode: 'add', data: driverData(out) });
          break;
        case 'name-other-carrier': if (d === 'new') ops.push({ kind: 'driver', mode: 'add', data: driverData(out) }); break;
        case 'driver-new': if (d === 'register') ops.push({ kind: 'driver', mode: 'add', data: driverData(out) }); break;
        case 'dup-import': if (d === 'skip') skip = true; break;
        default: break;
      }
    });
    return { row: out, skip: skip, ops: ops, blockers: blockers };
  }
  function pick(o, keys) { var r = {}; keys.forEach(function (k) { r[k] = o[k] == null ? '' : o[k]; }); return r; }

  /** 複数行の ops を統合する(同じ新規登録は1つに、同じ行の更新は最後の値を採用)。 */
  function mergeOps(opsList) {
    var adds = {}, ups = {}, result = [];
    opsList.forEach(function (ops) {
      ops.forEach(function (op) {
        if (op.mode === 'add') {
          var k = op.kind + '|' + (op.kind === 'vehicle' ? plateKey(op.data.車番) : companyKey(op.data.運送業者) + '|' + nameKey(op.data.氏名) + '|' + phoneDigits(op.data.携帯番号));
          if (adds[k]) return; adds[k] = true; result.push(op);
        } else {
          var u = op.kind + '|' + op.row;
          if (ups[u]) { ups[u].data = op.data; return; }
          ups[u] = op; result.push(op);
        }
      });
    });
    return result;
  }

  /** マスタ内の重複(車番・氏名+運送業者・携帯番号)を検出。キー→行番号配列で、2件以上のものだけ。 */
  function findMasterDups(vehicles, drivers) {
    var vd = {}, dd = {}, pd = {};
    vehicles.forEach(function (v) { var k = plateKey(v.車番); if (k) push(vd, k, v._row); });
    drivers.forEach(function (d) {
      push(dd, companyKey(d.運送業者) + '|' + nameKey(d.氏名), d._row);
      var p = phoneDigits(d.携帯番号); if (p) push(pd, p, d._row);
    });
    function multi(m) { var r = {}; Object.keys(m).forEach(function (k) { if (m[k].length > 1) r[k] = m[k]; }); return r; }
    return { vehiclePlate: multi(vd), driverName: multi(dd), driverPhone: multi(pd) };
  }

  // ---------- 変更・追加・取消(一度受領した連絡の続報) ----------
  var CHECK_FIELDS = ['手配業者', '積日', '卸日', '行先', '着時間', '運送業者', '車種', '車番', '氏名', '携帯番号', '工事番号', '現場名'];
  var INHERIT = ['積日', '卸日', '行先', '着時間', '車種'];

  function effectiveKind(res) {
    return res.kind === '新規' && res.rows.some(function (r) { return r.struck; }) ? '変更' : res.kind;
  }
  function isChange(res) { return effectiveKind(res) !== '新規'; }

  function recFields(rec) { var o = {}; CHECK_FIELDS.forEach(function (f) { o[f] = rec[f] == null ? '' : String(rec[f]); }); return o; }
  function recToRow(rec) {
    return { 工事番号: rec.工事番号 || '', 現場名: rec.現場名 || '', 業者: rec.手配業者 || '', 積日: rec.積日 || '', 卸日: rec.卸日 || '', 行先: rec.行先 || '', 着時間: rec.着時間 || '',
      運送業者: rec.運送業者 || '', 車種: rec.車種 || '', 車番: rec.車番 || '', 氏名: rec.氏名 || '', 携帯番号: rec.携帯番号 || '' };
  }
  function copyRow(r) { var o = {}; ROW_FIELDS.forEach(function (f) { o[f] = r[f] || ''; }); return o; }
  function inheritFrom(row, src) { if (!src) return; INHERIT.forEach(function (f) { if (!row[f] && src[f]) row[f] = src[f]; }); }

  /** 2つの値が「違う」か(表記ゆれは同じとみなす)。 */
  function fieldDiffers(f, a, b) {
    a = a == null ? '' : a; b = b == null ? '' : b;
    switch (f) {
      case '業者': case '手配業者': case '運送業者': return companyKey(a) !== companyKey(b);
      case '車番': return plateKey(a) !== plateKey(b);
      case '氏名': return nameKey(a) !== nameKey(b);
      case '携帯番号': return phoneDigits(a) !== phoneDigits(b);
      case '車種': case '行先': return typeKey(a) !== typeKey(b);
      default: return clean(a) !== clean(b);
    }
  }
  function destMatch(a, b) { var x = compact(a), y = compact(b); if (!x || !y) return true; return x === y || x.indexOf(y) >= 0 || y.indexOf(x) >= 0; }

  /** 取込一覧の記録(records)から、「元の記録」の候補を点数順に返す。
   *  点数: 取消線の車番と同じ=4、今回の車番と同じ=3、同じ手配(手配業者+積日+行先)=1。 */
  function candidatesFor(row, struck, records) {
    var sp = struck ? plateKey(struck.車番) : '', np = plateKey(row.車番), out = [];
    (records || []).forEach(function (r) {
      if (companyKey(r.手配業者) !== companyKey(row.業者)) return;
      var rp = plateKey(r.車番);
      var plateOld = !!sp && rp === sp, plateNew = !!np && rp === np;
      var strong = (!row.積日 || r.積日 === row.積日) && destMatch(r.行先, row.行先);
      var score = (plateOld ? 4 : 0) + (plateNew ? 3 : 0) + (strong ? 1 : 0);
      if (plateOld || plateNew || strong) out.push({ rec: r, score: score });
    });
    out.sort(function (a, b) { return b.score - a.score; });
    return out;
  }
  /** 迷わない場合だけ既定で選ぶ(車番が一致し、1番手が1つに決まるとき)。 */
  function defaultPick(c) {
    if (!c.length || c[0].score < 3) return null;
    return (c.length === 1 || c[1].score < c[0].score) ? 0 : null;
  }

  /** 候補を選んだ(idx。null=該当なし)ときの更新。空欄の項目は元の記録から引き継ぐ。 */
  function setPick(item, idx) {
    item.pick = idx;
    var rec = idx != null && item.candidates[idx] ? item.candidates[idx].rec : null;
    if (rec && item.newRow) {
      var base = recToRow(rec);
      inheritFrom(item.newRow, base);
      if (!item.newRow.工事番号) { item.newRow.工事番号 = base.工事番号; item.newRow.現場名 = base.現場名; }
    }
    item.action = rec ? 'apply' : (item.type === 'add' ? 'apply' : null);
  }

  /** FAXの読み取り結果(res)と取込一覧の記録(records)から、変更・追加・取消の一覧(items)を作る。
   *  item: {id, type:'update'|'add'|'cancel', newRow, struckRow, candidates, pick, action, decisions}
   *  action: null(未選択)|'apply'|'asnew'|'skip' */
  function buildChangePlan(res, records, kindOverride) {
    var kind = kindOverride || effectiveKind(res);
    var struck = res.rows.filter(function (r) { return r.struck; }), live = res.rows.filter(function (r) { return !r.struck; });
    var items = [], n = 0;
    function mk(type, newRow, struckRow, cands) {
      var it = { id: ++n, type: type, newRow: newRow, struckRow: struckRow, candidates: cands, pick: null, action: null, decisions: {} };
      items.push(it); return it;
    }
    if (kind === '取消') {
      res.rows.forEach(function (r) { var it = mk('cancel', null, r, candidatesFor(r, null, records)); setPick(it, defaultPick(it.candidates)); });
    } else if (kind === '追加') {
      live.forEach(function (r) {
        var nr = copyRow(r), c = candidatesFor(nr, null, records);
        if (c.length) { inheritFrom(nr, recToRow(c[0].rec)); if (!nr.工事番号) { nr.工事番号 = c[0].rec.工事番号 || ''; nr.現場名 = c[0].rec.現場名 || ''; } }
        var it = mk('add', nr, null, c); setPick(it, null);
      });
    } else { // 変更
      live.forEach(function (r, i) {
        var s = struck[i] || null, nr = copyRow(r);
        if (s) inheritFrom(nr, s);
        var c = candidatesFor(nr, s, records);
        if (struck.length && !s) { // 取消線の行より多い行は、追加の1台
          if (c.length) { inheritFrom(nr, recToRow(c[0].rec)); if (!nr.工事番号) { nr.工事番号 = c[0].rec.工事番号 || ''; nr.現場名 = c[0].rec.現場名 || ''; } }
          var ad = mk('add', nr, null, c); setPick(ad, null); return;
        }
        if (!c.length) { var ad2 = mk('add', nr, null, c); setPick(ad2, null); return; } // 元の記録が無ければ、追加として記録する
        var it = mk('update', nr, s, c); setPick(it, defaultPick(c));
      });
      struck.slice(live.length).forEach(function (s) { // 置き換え先のない取消線の行=取消
        var it = mk('cancel', null, s, candidatesFor(s, null, records)); setPick(it, defaultPick(it.candidates));
      });
    }
    return { kind: kind, items: items };
  }

  return {
    effectiveKind: effectiveKind, isChange: isChange, buildChangePlan: buildChangePlan, setPick: setPick, candidatesFor: candidatesFor,
    fieldDiffers: fieldDiffers, recFields: recFields, recToRow: recToRow, CHECK_FIELDS: CHECK_FIELDS, normKind: normKind,
    ROW_FIELDS: ROW_FIELDS, normDate: normDate, normTime: normTime, plateKey: plateKey, fmtPlate: fmtPlate, companyKey: companyKey,
    nameKey: nameKey, phoneDigits: phoneDigits, fmtPhone: fmtPhone, isMobile: isMobile, importKey: importKey,
    buildDestMap: buildDestMap, suggestProject: suggestProject, projectName: projectName, sanitizeOcr: sanitizeOcr, evaluateBatch: evaluateBatch, resolveRow: resolveRow, mergeOps: mergeOps, findMasterDups: findMasterDups
  };
});
