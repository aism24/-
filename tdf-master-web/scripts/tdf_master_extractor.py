"""実寸法師(.tdf)から製品マスタ情報(図番・製品マーク・設計符号・サイズ・本数・
重量・長さ・左継手・右継手)を抽出するロジック。

2026-09-11、YK-AB01(普通梁)・WR-1G-1(斜め梁)の2ファイルの実機解析で確立した
ルールをコード化したもの。適用範囲はこの2パターンの検証に基づく。

前提となる図面構造:
  - 製品情報は「製品マーク | 設計符号 | サイズ | 本数(N台) [| 重量(N.Nkg)]」という
    横並びテーブルとして、pad=0の通常テキストで描画されている。
  - 図番はタイトル欄のテキスト(高さH=100前後、他の注記より大きい)。
  - 「長さ」は、製品マーク〜本数のX範囲・製品マークのYより上にある数値寸法群の
    うち、(a)図面の主軸方向に沿う直線と長さが一致する本数が最多で、
    (b)出現回数が多すぎる値(取付ピッチ)は原則除外するが、他の系列との合計が
    一致するなら復活する、という手順で1つに絞り込む。
  - 「左継手・右継手」は、長丸(半径が一致し開始角の差が180度の円弧ペア)の
    中心に対応するテキストを候補とし、回転後座標で同じY(勾配)を持つペアを
    その製品の継手とみなし、X(回転後)の小さい方を左、大きい方を右とする。
"""
from __future__ import annotations

import collections
import math
import re
from dataclasses import dataclass, field

import tdf_binary as tb


# ---------------------------------------------------------------------------
# 共通ユーティリティ
# ---------------------------------------------------------------------------

def _try_float(s: str | None) -> float | None:
    if s is None:
        return None
    try:
        return float(s)
    except ValueError:
        return None


# 断面種別の接頭辞。2026-09-15、「TDF＿マスタ作成」スプレッドシートの
# 設定シート(サイズ／重量対応表、4016件)を全件突き合わせて確定した一覧
# (ボルト類[12GSHTB/F10T等]・フラットバー[FB]・PI[プレート系]は対象外、
# ユーザー確認済み)。H系統(HF/HFT/HY/HYT)・L系統(LH)は接頭辞が長い方を
# 先に置く必要はない(全体一致に失敗すれば他の候補へバックトラックされる
# ため)が、可読性のため長い接頭辞を先に並べている。
# 2026-09-16、KIX01現場`S-1 R1G-07`で`MHY-1200x500x22x40`という表記
# (`M`+H系統)が実データで初めて確認されたため追加。
SIZE_PATTERN = re.compile(
    r"^(BBOX|BCP|BCR|BOX|BH|BT|CT|C|MHY|HFT|HYT|HF|HY|H|I|LH|L|P|SH|TH|[0-9]+φ|\[|角)[\-‐]?\s*[0-9]"
)

# 「同じ行」とみなすY座標の許容誤差。当初1.0(ほぼ完全一致)だったが、
# WA1-1B-02Aで、同じ行のはずのマーク+本数セル(Y=10984.3)と設計符号+
# サイズセル(Y=10978.0)の間に6.3程度のズレがあり、行として認識されず
# 2マーク(WA11-1TB441-5/6)が丸ごと欠落する不具合があった(2026-09-14)。
# 行間隔は実測240前後あるため、10.0に広げても別の行と混同するリスクは
# 十分小さい。
SAME_ROW_Y_TOLERANCE = 10.0


def _looks_like_size(text: str) -> bool:
    return bool(SIZE_PATTERN.match(text.strip()))


# ---------------------------------------------------------------------------
# 製品情報テーブルの検出
# ---------------------------------------------------------------------------

@dataclass
class ProductRow:
    mark: str
    design_code: str | None
    size: str | None
    count: str | None
    weight: str | None
    x_mark: float
    x_next: float  # 本数セルのX座標(長さ判定のX範囲右端に使う)
    y: float
    length: float | None = None
    left_joint: str | None = None
    right_joint: str | None = None
    drawing_number: str | None = None
    # True: find_product_rows_no_size(「マーク|設計符号|本数」3項目パターン)由来の行。
    # この行だけ、長さ・継手・サイズの判定を別の専用ロジック(determine_length_no_size等)に
    # 振り分ける(既存の4項目パターン向けdetermine_length等は一切変更しない)。
    # デフォルトFalseのため、既存のfind_product_rows/find_product_rows_shared_groupが
    # 作る行には影響しない(2026-09-16、KIX01現場`N-1 2G-05`対応)。
    size_missing: bool = False


def find_product_rows(tdf: tb.TdfData) -> list[ProductRow]:
    """「N台」セルを起点に、同じ行の製品マーク・設計符号・サイズを逆算して集める。

    本体・参照のどちらも行の起点になり得るため、resolve_text()で文字列を解決した
    上で、実際の配置座標(重複しない)ごとに1行として扱う。
    """
    dai_cells = []
    for r in tdf.texts:
        if r.rot != 0:
            continue
        text = tdf.resolve_text(r)
        if text and tb.is_dai_cell(text):
            dai_cells.append(r)

    rows: list[ProductRow] = []
    for dai in dai_cells:
        # 同じ行とみなせるY範囲で、Xがdaiより小さい通常テキスト(rot=0)を
        # 集めて左から並べる
        same_row = [
            r for r in tdf.texts
            if r.rot == 0 and abs(r.y - dai.y) < SAME_ROW_Y_TOLERANCE and r.x < dai.x and tdf.resolve_text(r)
        ]
        same_row.sort(key=lambda r: r.x)
        if len(same_row) < 3:
            continue
        # 直近3つを [製品マーク, 設計符号, サイズ] の順とみなす(サイズがdaiに一番近い)
        size_rec, code_rec, mark_rec = same_row[-1], same_row[-2], same_row[-3]
        size_text = tdf.resolve_text(size_rec)
        if not _looks_like_size(size_text):
            continue

        # 重量(daiより右、ほぼ同じY、"N.Nkg"形式)があれば拾う。重量セルは本数セルと
        # 数ピクセル分Yがずれることがあるため、許容幅を広めに取る。
        weight_text = None
        same_row_right = [
            r for r in tdf.texts
            if r.rot == 0 and abs(r.y - dai.y) < 100.0 and r.x > dai.x and tdf.resolve_text(r)
        ]
        same_row_right.sort(key=lambda r: r.x)
        if same_row_right:
            cand = tdf.resolve_text(same_row_right[0])
            if cand and cand.rstrip().endswith("kg"):
                weight_text = cand

        rows.append(ProductRow(
            mark=tdf.resolve_text(mark_rec), design_code=tdf.resolve_text(code_rec),
            size=size_text, count=tdf.resolve_text(dai), weight=weight_text,
            x_mark=mark_rec.x, x_next=dai.x, y=dai.y,
        ))

    rows.sort(key=lambda r: r.x_mark)
    return rows


def find_product_rows_no_size(
    tdf: tb.TdfData, existing_positions: set[tuple[float, float]] | None = None,
) -> list[ProductRow]:
    """「製品マーク | 設計符号 | 本数(N台)」の3項目パターン(サイズ省略)を検出する。

    `find_product_rows`(4項目: マーク・設計符号・サイズ・本数)では見つからない
    「N台」セルを対象に、直近2つを[設計符号, マーク]とみなす。サイズが元々
    描かれていない図面(2026-09-16、KIX01現場`N-1 2G-05`で発覚)に対応する。

    同じY(行)に複数の「N台」セルが離れて並ぶ図面では、単純に「daiより
    小さい全X」を対象にすると、手前の別の製品の本数・マーク等まで巻き込んで
    しまう(例: マーク単体の行が2つ、同じYに離れて存在する場合)。これを
    避けるため、同じY(行)にある**直前の**「N台」セルより右側だけを検索範囲
    とする(直前の「N台」が無ければ従来通り無制限)。
    """
    existing_positions = existing_positions or set()

    dai_cells = []
    for r in tdf.texts:
        if r.rot != 0:
            continue
        text = tdf.resolve_text(r)
        if text and tb.is_dai_cell(text):
            key = (round(r.x, 1), round(r.y, 1))
            if key in existing_positions:
                continue
            dai_cells.append(r)

    # 行(Y)ごとに「N台」セルをX昇順で並べ、直前の境界を求めるための索引を作る
    dai_by_row: dict[float, list] = {}
    for r in tdf.texts:
        if r.rot != 0:
            continue
        text = tdf.resolve_text(r)
        if text and tb.is_dai_cell(text):
            dai_by_row.setdefault(round(r.y, 1), []).append(r)
    for members in dai_by_row.values():
        members.sort(key=lambda r: r.x)

    rows: list[ProductRow] = []
    for dai in dai_cells:
        row_key = round(dai.y, 1)
        siblings = dai_by_row.get(row_key, [])
        prev_x = max(
            (r.x for r in siblings if r.x < dai.x), default=None,
        )
        same_row = [
            r for r in tdf.texts
            if r.rot == 0 and abs(r.y - dai.y) < SAME_ROW_Y_TOLERANCE
            and r.x < dai.x and (prev_x is None or r.x > prev_x)
            and tdf.resolve_text(r)
        ]
        same_row.sort(key=lambda r: r.x)
        if len(same_row) < 2:
            continue
        code_rec, mark_rec = same_row[-1], same_row[-2]
        code_text = tdf.resolve_text(code_rec)
        if _looks_like_size(code_text):
            # サイズが実は描かれていた(3つ目が本来のサイズ)=4項目パターンの
            # 対象であり、既にfind_product_rowsで処理されているはず。ここでは
            # 二重集計を避けるため無視する。
            continue

        rows.append(ProductRow(
            mark=tdf.resolve_text(mark_rec), design_code=code_text,
            size=None, count=tdf.resolve_text(dai), weight=None,
            x_mark=mark_rec.x, x_next=dai.x, y=dai.y,
            size_missing=True,
        ))

    rows.sort(key=lambda r: r.x_mark)
    return rows


_DRAWING_NUMBER_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9\-]{2,19}$")

# ラベル(「図面番号」)近傍の候補にのみ適用する緩和版パターン。現場によっては
# 図番の区切りに半角/全角スペースが使われることがある(例: "N-1 2G-5"が
# "N-1 2G-5"のようにスペースを含んだ1つのテキストとして描画される)。
# ページ全体を対象とするフォールバック(文字高さ最大)にこの緩和を適用すると、
# スペースを含む無関係な注記(タイトル欄の他の項目等)まで拾ってしまう
# リスクが上がるため、緩和はラベルとの位置的な近さで絞り込んだ候補にのみ
# 適用する(2026-09-16、KIX01現場の`N-1 2G-05`で図番が読み取れない問題を
# 受けて追加)。
_DRAWING_NUMBER_PATTERN_LOOSE = re.compile(r"^[A-Za-z][A-Za-z0-9\- 　]{2,19}$")


def _find_zumenbango_label_pos(tdf: tb.TdfData) -> tuple[float, float] | None:
    """「図」「面」「番」「号」の4文字が同じY・等間隔でX方向に連続して並ぶ
    箇所(タイトル欄の「図面番号」ラベルそのもの)を探し、その(Y, X中心)を
    返す。単独の「図」「面」等の文字が他の場所にも現れることがあるため、
    4文字が実際に連続しているものだけを対象にする。"""
    chars: dict[str, list] = {"図": [], "面": [], "番": [], "号": []}
    for r in tdf.texts:
        text = tdf.resolve_text(r)
        if text and r.rot == 0 and text.strip() in chars:
            chars[text.strip()].append(r)

    if not all(chars.values()):
        return None

    for zu in chars["図"]:
        row = [zu]
        cur = zu
        for nextchar in ("面", "番", "号"):
            cand = [
                r for r in chars[nextchar]
                if abs(r.y - zu.y) < 1.0 and cur.x < r.x < cur.x + cur.h * 3
            ]
            if not cand:
                break
            cur = min(cand, key=lambda r: r.x)
            row.append(cur)
        else:
            return (zu.y, sum(r.x for r in row) / len(row))
    return None


def find_drawing_number(tdf: tb.TdfData) -> str | None:
    """タイトル欄の図番らしきテキストを推定する。

    まず「図面番号」ラベル(4文字が連続して並ぶ箇所)を探し、その近く
    (Y座標の差が500mm以内)にある英数字+ハイフンの候補の中で、ラベルに
    最もX方向で近いものを図番として採用する。ラベルが見つからない場合や
    近くに候補が無い場合は、従来通り文字高さが最も大きいものを採用する
    (フォールバック)。

    2026-09-14、鳥取現場図面EA1-1G-14で、製品テーブルの「設計符号」欄が
    たまたまタイトル欄の図番と同じ文字高さだったため誤って設計符号の方を
    採用してしまう問題が発覚し、位置情報(ラベルとの近さ)を優先する方式に
    改訂した。"""
    candidates = []
    for r in tdf.texts:
        if r.text is None or r.rot != 0:
            continue
        t = r.text.strip()
        if _DRAWING_NUMBER_PATTERN.match(t) and not t.isdigit():
            candidates.append(r)

    label_pos = _find_zumenbango_label_pos(tdf)
    if label_pos is not None:
        label_y, label_x = label_pos
        # ラベル近傍だけは緩和版パターン(スペース許容)で候補を探し直す。
        # 緩和版は非緩和版を包含するため、従来一致していたものは変わらず
        # 一致し続ける。
        near = []
        for r in tdf.texts:
            if r.text is None or r.rot != 0:
                continue
            t = r.text.strip()
            if not t or t.isdigit():
                continue
            if not _DRAWING_NUMBER_PATTERN_LOOSE.match(t):
                continue
            if abs(r.y - label_y) < 500.0:
                near.append(r)
        if near:
            near.sort(key=lambda r: abs(r.x - label_x))
            return near[0].text.strip()

    if not candidates:
        return None
    candidates.sort(key=lambda r: -r.h)
    return candidates[0].text.strip()


# ---------------------------------------------------------------------------
# 「長さ」の判定
# ---------------------------------------------------------------------------

def _axis_key(rot_deg: float, xr: float, yr: float) -> tuple[str, float]:
    r = rot_deg % 180
    if r > 90:
        r = 180 - r
    if r < 45:
        return ("yr", round(yr, 0))
    return ("xr", round(xr, 0))


def determine_length(tdf: tb.TdfData, x_min: float, x_max: float, y_ref: float,
                      min_value: float = 300.0, y_max: float | None = None) -> tuple[float | None, dict]:
    """製品のX範囲・Y範囲内から「長さ」を1つに絞り込む。

    `y_max`を指定すると、Y範囲の上限をそこで打ち切る(1枚の図面に梁の
    立面が2段に描かれている場合、下段の行から見て上段の行より上は
    別の梁の寸法線なので含めてはいけない。2026-09-14追加)。指定が無い
    場合は従来通り上方向は無制限。

    戻り値: (長さの値 or None, デバッグ情報dict)
    """
    seen_coords = set()
    items = []  # (text, value, x, y, rot, xr, yr)
    for r in tdf.texts:
        text = tdf.resolve_text(r)
        v = _try_float(text)
        if v is None:
            continue
        if not (x_min <= r.x <= x_max and r.y > y_ref and (y_max is None or r.y < y_max)):
            continue
        key = (round(r.x, 1), round(r.y, 1))
        if key in seen_coords:
            continue
        seen_coords.add(key)
        rot = tdf.resolve_rot(r)
        theta = -rot
        xr = r.x * math.cos(theta) - r.y * math.sin(theta)
        yr = r.x * math.sin(theta) + r.y * math.cos(theta)
        items.append((text, v, r.x, r.y, rot, xr, yr))

    if not items:
        return None, {"reason": "no numeric texts in range"}

    # 主軸方向(最頻のrot)を推定。回転行列の計算に使うため、符号を保持した
    # 生の角度(-180〜180)のまま集計する(% 180で丸めると符号情報が失われ、
    # 後段の回転変換が180度近くずれてしまう)。
    # 1/5フィルタ(次のステップ)より前の、絞り込み前の全テキストから求める。
    # 先に1/5フィルタをかけてしまうと、たまたま小さい値ばかりが多い向きの
    # テキストが削られて、残った少数派の向きに主軸が引っ張られることがある
    # (2026-09-14、夢前現場図面WA1-1G-02で確認。フィルタ順序を修正)。
    rot_counts: dict[float, int] = {}
    for _t, _v, _x, _y, rot, _xr, _yr in items:
        key = round(math.degrees(rot), 1)
        rot_counts[key] = rot_counts.get(key, 0) + 1
    main_axis_deg = max(rot_counts.items(), key=lambda kv: kv[1])[0]

    # 範囲内の最大値の1/5未満の値は「取付ピッチ」等の小さい寸法とみなし、
    # 長さ候補から除外する(小さすぎる値がスコアリングで誤って勝つのを防ぐ)。
    max_v = max(v for _t, v, *_ in items)
    threshold = max_v / 5.0
    items = [it for it in items if it[1] >= threshold]
    if not items:
        return None, {"reason": "no items after 1/5 filter"}

    # 出現回数
    occurrence: dict[float, list] = {}
    for text, v, x, y, rot, xr, yr in items:
        occurrence.setdefault(round(v, 2), []).append((x, y))

    # 回転後座標でのグループ化(取付ピッチ系列の検出)
    group_map: dict[tuple, list] = {}
    for text, v, x, y, rot, xr, yr in items:
        key = _axis_key(math.degrees(rot), xr, yr)
        group_map.setdefault(key, []).append((text, v, x, y, xr, yr))

    excluded = set()
    for val, coords in occurrence.items():
        if len(coords) >= 5:
            excluded.add(val)
    for key, members in group_map.items():
        if len(members) >= 3:
            for text, v, x, y, xr, yr in members:
                excluded.add(round(v, 2))

    group_sums = []
    for key, members in group_map.items():
        total = sum(v for text, v, x, y, xr, yr in members)
        group_sums.append((key, total, len(members), [m[0] for m in members]))

    # 除外された値でも他系列合計と一致するなら復活
    revived = set()
    for val in list(excluded):
        for key, total, cnt, texts in group_sums:
            member_vals = {round(_try_float(tx), 2) for tx in texts if _try_float(tx) is not None}
            if val in member_vals:
                continue
            if abs(total - val) < 1.0:
                revived.add(val)
                break

    def line_angle_deg(x1, y1, x2, y2):
        return math.degrees(math.atan2(y2 - y1, x2 - x1)) % 180

    def has_primary_line(val, angle_tol=5.0):
        """ref0==3(実寸法師が自動生成する主要な寸法線)の一致直線が
        1本でもあれば、取付ピッチ等の繰り返し寸法とみなす除外ロジックを
        無視して良いという確実な証拠になる(2026-09-14、EA2-1G-11で、本来
        の長さが他の数値と同じ行に並んでいたために誤って除外されていた
        問題を受けて追加)。"""
        for ln in tdf.lines:
            if ln.ref0 != 3:
                continue
            mid_x = (ln.x1 + ln.x2) / 2
            if not (x_min <= mid_x <= x_max and ln.y1 > y_ref and ln.y2 > y_ref
                    and (y_max is None or (ln.y1 < y_max and ln.y2 < y_max))):
                continue
            if abs(ln.length - val) >= 0.5:
                continue
            ang = line_angle_deg(ln.x1, ln.y1, ln.x2, ln.y2)
            diff = abs(ang - main_axis_deg)
            diff = min(diff, 180 - diff)
            if diff <= angle_tol:
                return True
        return False

    candidates = [
        round(v, 2) for v in occurrence
        if v > min_value and (
            round(v, 2) not in excluded
            or round(v, 2) in revived
            or has_primary_line(round(v, 2))
        )
    ]
    if not candidates:
        return None, {"reason": "no candidates after filtering", "main_axis_deg": main_axis_deg}

    def count_matching_lines(val, angle_tol=5.0):
        cnt = 0
        primary_cnt = 0  # ref0==3(実寸法師が自動生成する主要な寸法線)の本数
        for ln in tdf.lines:
            mid_x = (ln.x1 + ln.x2) / 2
            if not (x_min <= mid_x <= x_max and ln.y1 > y_ref and ln.y2 > y_ref
                    and (y_max is None or (ln.y1 < y_max and ln.y2 < y_max))):
                continue
            if abs(ln.length - val) >= 0.5:
                continue
            ang = line_angle_deg(ln.x1, ln.y1, ln.x2, ln.y2)
            diff = abs(ang - main_axis_deg)
            diff = min(diff, 180 - diff)
            if diff <= angle_tol:
                cnt += 1
                if ln.ref0 == 3:
                    primary_cnt += 1
        return cnt, primary_cnt

    scored = []
    for val in candidates:
        a, primary_cnt = count_matching_lines(val)
        b = sum(1 for key, total, cnt, texts in group_sums if abs(total - val) < 1.0)
        scored.append((val, a, b, primary_cnt))

    # ref0==3の本数(主要寸法線としての一致数)を最優先。同点ならa、さらに同点ならb。
    # ボルトピッチ・リブ等の手動追加線はref0が3以外の値を持つため、これらの
    # 候補は自然と後順位になる(2026-09-14、鳥取現場図面での検証で確立)。
    scored.sort(key=lambda x: (-x[3], -x[1], -x[2]))

    best = scored[0]
    debug = {"main_axis_deg": main_axis_deg, "candidates": scored,
              "threshold": threshold, "max_v": max_v}
    if best[3] == 0 and best[1] == 0:
        # フォールバック(2026-09-14追加): 小梁の斜め材で、寸法テキスト自身の
        # rotが部材の傾きと一致しないケース(EA2-1B-03のEA21-1b2)があり、
        # main_axis_deg(テキストのrot多数決)が誤って0度になってしまい、
        # 本来の長さ(斜め方向の直線)が「主軸不一致」で除外されてしまっていた。
        # この場合に限り、向きを問わず「長さが完全一致する直線の本数」だけで
        # 再スコアリングする(ユーザー確認: EA21-1b2-1/2の正解2688.6は、
        # 向きが斜め[157.17度]の直線が範囲内に7本[最多]あることで裏付けられる)。
        # 通常ケース(大梁48ファイル・小梁の他の行)は最初のスコアリングで
        # 候補が見つかるため、このフォールバックが実行されることはない。
        any_angle_scored = []
        for val, _a, b, _primary_cnt in scored:
            cnt = 0
            primary_cnt = 0
            for ln in tdf.lines:
                mid_x = (ln.x1 + ln.x2) / 2
                if not (x_min <= mid_x <= x_max and ln.y1 > y_ref and ln.y2 > y_ref
                        and (y_max is None or (ln.y1 < y_max and ln.y2 < y_max))):
                    continue
                if abs(ln.length - val) >= 0.5:
                    continue
                cnt += 1
                if ln.ref0 == 3:
                    primary_cnt += 1
            any_angle_scored.append((val, cnt, b, primary_cnt))
        any_angle_scored.sort(key=lambda x: (-x[3], -x[1], -x[2]))
        fallback_best = any_angle_scored[0]
        debug["any_angle_candidates"] = any_angle_scored
        if fallback_best[3] == 0 and fallback_best[1] == 0:
            return None, {**debug, "reason": "no direction-matched line for any candidate"}

        # 採用した値に実際に一致した直線自身の角度を、真の主軸として
        # 採用し直す(2026-09-14追加。フォールバック前のmain_axis_degは
        # テキストのrot多数決による誤った値[0度]のままだったため、
        # 「種別」列[普通梁/斜め梁]の判定にも誤って使われ、EA21-1b2
        # [実際は斜め梁]が「普通梁」と誤表示される不具合があった)。
        matched_angles: dict[float, int] = {}
        for ln in tdf.lines:
            mid_x = (ln.x1 + ln.x2) / 2
            if not (x_min <= mid_x <= x_max and ln.y1 > y_ref and ln.y2 > y_ref
                    and (y_max is None or (ln.y1 < y_max and ln.y2 < y_max))):
                continue
            if abs(ln.length - fallback_best[0]) >= 0.5:
                continue
            ang = round(line_angle_deg(ln.x1, ln.y1, ln.x2, ln.y2), 1)
            matched_angles[ang] = matched_angles.get(ang, 0) + 1
        if matched_angles:
            debug["main_axis_deg"] = max(matched_angles.items(), key=lambda kv: kv[1])[0]

        return fallback_best[0], {**debug, "reason": "axis-less fallback used"}
    return best[0], debug


# ---------------------------------------------------------------------------
# 「左継手・右継手」の判定
# ---------------------------------------------------------------------------

def find_stadium_centers(tdf: tb.TdfData, angle_tol_deg: float = 1.0,
                          radius_tol: float = 0.5, max_dist_factor: float = 20.0):
    """長丸(半径一致・開始角180度差の円弧ペア)の中心座標を全部求める。"""
    arcs = [a for a in tdf.arcs if a.a1 is not None]
    centers = []
    used = set()
    n = len(arcs)
    for i in range(n):
        a = arcs[i]
        if a.offset in used:
            continue
        for j in range(i + 1, n):
            b = arcs[j]
            if b.offset in used:
                continue
            if abs(a.r - b.r) > radius_tol:
                continue
            a1d = math.degrees(a.a1)
            b1d = math.degrees(b.a1)
            diff = abs((a1d - b1d) % 360)
            diff = min(diff, 360 - diff)
            if abs(diff - 180.0) > angle_tol_deg:
                continue
            dist = math.hypot(b.cx - a.cx, b.cy - a.cy)
            if not (0.1 < dist < a.r * max_dist_factor):
                continue
            mid_x = (a.cx + b.cx) / 2
            mid_y = (a.cy + b.cy) / 2
            centers.append((mid_x, mid_y, a.r))
            used.add(a.offset)
            used.add(b.offset)
            break
    return centers


JOINT_CODE_PATTERN = re.compile(r"^GJ")


def determine_joints(tdf: tb.TdfData, x_min: float, x_max: float, y_ref: float,
                      main_axis_deg: float, length_value: float,
                      x_tolerance_factor: float = 0.6,
                      y_max: float | None = None) -> tuple[str | None, str | None]:
    """長丸で囲まれた継手候補のうち、継手コード特有の文字列パターン(`GJ`で
    始まる)に一致するものだけを対象に、製品マーク側(左)・本数セル側(右)の
    それぞれに最も近いものを左右継手として採用する。

    継手コードは図面内で必ず`GJ`始まりであり(`P441`や`TB888`等の無関係な
    部材記号はこのパターンに一致しない)、「N台」パターンと同様に文字列
    そのもので確実に識別できる(2026-09-14、鳥取現場図面での検証で確立)。
    片側にしか継手が無い図面では、該当側の候補が遠すぎる(x_tolerance_factor
    ×lengthを超える)場合にNoneを返す。

    `y_max`を指定すると、長さ判定(determine_length)と同様にY範囲の上限を
    打ち切る(1枚の図面に梁の立面が2段に描かれている場合、下段の行から
    見て上段の行より上にある継手は別の梁のものなので含めてはいけない。
    2026-09-14追加)。
    """
    centers = find_stadium_centers(tdf)
    theta = -math.radians(main_axis_deg)

    def rotate(x, y):
        xr = x * math.cos(theta) - y * math.sin(theta)
        yr = x * math.sin(theta) + y * math.cos(theta)
        return xr, yr

    x_mark_r, _ = rotate(x_min, y_ref)
    x_next_r, _ = rotate(x_max, y_ref)

    joint_candidates = []
    for mx, my, r in centers:
        near = [rec for rec in tdf.texts if abs(rec.x - mx) < 3 and abs(rec.y - my) < 3]
        for rec in near:
            text = tdf.resolve_text(rec)
            if not text or not JOINT_CODE_PATTERN.match(text):
                continue
            if my <= y_ref or (y_max is not None and my >= y_max):
                continue
            xr, yr = rotate(mx, my)
            joint_candidates.append((text, xr))

    if not joint_candidates:
        return None, None

    threshold = length_value * x_tolerance_factor
    left_best = min(joint_candidates, key=lambda c: abs(c[1] - x_mark_r))
    right_best = min(joint_candidates, key=lambda c: abs(c[1] - x_next_r))
    left = left_best[0] if abs(left_best[1] - x_mark_r) <= threshold else None
    right = right_best[0] if abs(right_best[1] - x_next_r) <= threshold else None
    return left, right


# ---------------------------------------------------------------------------
# メイン抽出処理
# ---------------------------------------------------------------------------

RELAX_MARGIN = 5000.0


# ---------------------------------------------------------------------------
# 「製品マーク|設計符号|本数(N台)」3項目パターン(サイズ省略)専用の
# 長さ・継手・サイズ判定
# ---------------------------------------------------------------------------
#
# find_product_rows_no_size()が見つけた行(ProductRow.size_missing=True)だけを
# 対象にする、完全に独立したロジック。既存の4項目パターン向け
# determine_length/determine_joints、および呼び出し元のfind_product_rows等は
# 一切変更していない。
#
# 2026-09-16、KIX01現場`N-1 2G-05`(2GX1Y3/G16N)で、既存ロジックの前提
# (マーク〜本数のX範囲が梁の見た目の全長に対応する)が成り立たない図面が
# 見つかったことを受けて追加。ユーザーと共に、姉妹アプリ(DXF抽出アプリ、
# 他社図面向けIndex他社図面.html)の考え方を参考に設計した:
#   - 長さ: 単純な「向き一致・長さ一致の直線本数が最多」ではなく、
#     DXFアプリの「サブ寸法和+直線連結性の検証」(_bottom_up_y_validate/
#     _filter_connected_nums_y)を移植して使う。
#   - 継手: 確定した長さと一致する直線の実端点(_find_reference_line_endpoints、
#     小梁側と共通の既存ユーティリティを流用)の近傍にある長丸のうち、
#     各端点に最も近いものを採用する(絶対閾値は設けない。DXFアプリの
#     nearest_sizeと同じ考え方)。
#   - サイズ: 各継手位置に最も近いサイズ文字列を探し、それが長さのX範囲の
#     外側にあれば「継手側(＝接続先部材)のサイズ」とみなし(DXFアプリの
#     is_joint_size)、そのY座標帯(±300)・長さのX範囲内で改めて探した
#     単一候補を採用する。
#
# 実例1件(N-1 2G-05)でのみ検証済み。ユーザー確認の上、以下は今回
# 意図的に対象外とした(実例が無いまま組むと根拠のない実装になるため):
#   - 斜め梁(種別判定自体は既存classify_beam_typeを流用し角度で判定するが、
#     斜め梁と判定された場合の長さ・サイズ抽出ロジックは無い)
#   - サブ寸法和が0件/複数値タイの場合のタイブレーク(空欄のままにする)
#   - サイズ候補が0件/複数件の場合のフォールバック(空欄のままにする)
#   - 製品段(tier)は既存のcompute_tier_info(呼び出し側でrows全体に対して
#     実行される)をそのまま流用する(この関数自体には手を加えない)。

_NUM_MIN_VALUE = 10.0
_SUBSUM_Y_GROUP_TOL = 10.0  # 連結性フィルタ用のYグループ化許容誤差
_SUBSUM_VALIDATE_Y_TOL = 50.0  # サブ寸法和検証用のYグループ化許容誤差(緩め)
# 2026-09-16、N-1 2G-10対応で500→2000に引き上げ: 500のままだと、梁本体とは
# 無関係な小さな数値(ボルト穴等の斜め注記400+200+200=800)が偶然近傍の別の
# 「800」ラベルと一致し、誤って全長として採用されてしまうケースがあった
# (実際の全長は9035で、9035自体は分解されない単一ラベルのため、こちらは
# 下の_line_length_frequency_no_sizeフォールバックで拾う)。この定数は
# determine_length_no_size専用で、既存4項目パターンのdetermine_lengthとは
# 無関係(そちらへの影響なし)。
_SUBSUM_MIN_SUM = 2000.0
_SIZE_JOINT_Y_BAND = 300.0
_LINE_FREQ_MIN_COUNT = 3  # 同一長さ直線の頻度フォールバック採用の最低本数
_LINE_FREQ_MIN_VALUE = 2000.0  # フォールバック候補の最小値(全長として現実的な下限)


def _collect_horiz_nums_no_size(tdf: tb.TdfData, x_min: float, x_max: float, y_ref: float):
    """y_refより上・[x_min,x_max]内にある数値テキストを(value, x, y, rot_deg)で集める。
    縦書き(90°±10°)は除外する(追い寸法のため長さ算出に使わない、という
    既存determine_lengthと同じ前提)。"""
    items = []
    for r in tdf.texts:
        text = tdf.resolve_text(r)
        if text is None:
            continue
        vc = text.strip()
        try:
            val = float(vc)
        except ValueError:
            continue
        if val < _NUM_MIN_VALUE:
            continue
        if not (x_min <= r.x <= x_max and r.y > y_ref):
            continue
        rot_deg = math.degrees(tdf.resolve_rot(r))
        if abs(abs(rot_deg) % 180 - 90) <= 10:
            continue
        items.append((val, r.x, r.y, rot_deg))
    return items


def _find_matching_line_x(tdf: tb.TdfData, val: float, tx: float, ty: float):
    """値valとほぼ同じ長さ(±0.1)の直線のうち、Y平均がtyに近く(±300)、
    中点XがtxはXに最も近いものの(min_x, max_x, y平均)を返す。無ければNone。"""
    best = None
    best_dx = float("inf")
    for ln in tdf.lines:
        if abs(ln.length - val) > 0.1:
            continue
        y_avg = (ln.y1 + ln.y2) / 2
        if abs(y_avg - ty) >= 300:
            continue
        cx = (ln.x1 + ln.x2) / 2
        dx = abs(cx - tx)
        if dx < best_dx:
            best_dx = dx
            best = (min(ln.x1, ln.x2), max(ln.x1, ln.x2), y_avg)
    return best


def _filter_connected_nums_no_size(tdf: tb.TdfData, nums_xy):
    """同一Y座標グループ内で、対応する直線の端点が実際に繋がっている
    (沿い方向の座標差50以内)最大の連結成分だけを残す。対応する直線が
    見つからない数値は無条件で残す(DXFアプリの_filter_connected_nums_yの
    移植)。"""
    if not nums_xy:
        return []
    annotated = [
        (val, tx, ty, ang, _find_matching_line_x(tdf, val, tx, ty))
        for val, tx, ty, ang in nums_xy
    ]

    groups: dict[float, list[int]] = {}
    grp_keys: list[float] = []
    for i, (_val, _tx, ty, _ang, _xr) in enumerate(annotated):
        placed = False
        for rep_y in grp_keys:
            if abs(ty - rep_y) <= _SUBSUM_Y_GROUP_TOL:
                groups[rep_y].append(i)
                placed = True
                break
        if not placed:
            grp_keys.append(ty)
            groups[ty] = [i]

    def _keep_largest_component(indices: list[int]) -> set[int]:
        if len(indices) <= 1:
            return set(indices)
        with_line = [(k, annotated[k]) for k in indices if annotated[k][-1] is not None]
        without_line = [k for k in indices if annotated[k][-1] is None]
        if len(with_line) <= 1:
            return set(indices)
        n = len(with_line)
        par = list(range(n))

        def _find(x):
            while par[x] != x:
                par[x] = par[par[x]]
                x = par[x]
            return x

        def _union(a, b):
            par[_find(a)] = _find(b)

        for a in range(n):
            xa = with_line[a][1][-1]
            for b in range(a + 1, n):
                xb = with_line[b][1][-1]
                if abs(xa[1] - xb[0]) <= 50 or abs(xb[1] - xa[0]) <= 50:
                    _union(a, b)
        comp_count: dict[int, int] = {}
        for k in range(n):
            c = _find(k)
            comp_count[c] = comp_count.get(c, 0) + 1
        max_size = max(comp_count.values())
        keep = set(without_line)
        for k, (orig_idx, _rec) in enumerate(with_line):
            if comp_count[_find(k)] == max_size:
                keep.add(orig_idx)
        return keep

    keep: set[int] = set()
    for indices in groups.values():
        keep |= _keep_largest_component(indices)

    result = []
    for i in range(len(nums_xy)):
        if i not in keep:
            continue
        line_range = annotated[i][4]
        eff_y = line_range[2] if line_range is not None else nums_xy[i][2]
        result.append((nums_xy[i][0], eff_y, nums_xy[i][3]))
    return result


def _bottom_up_validate_no_size(tdf: tb.TdfData, group_nums_y, target_nums_y):
    """同一Y-group(連結性フィルタ後、±50)の合算が、target_nums_y内の
    別の単体テキスト(水平のみ)と一致する回数を数える(DXFアプリの
    _bottom_up_y_validateの移植)。孤立した候補(近傍に他の数値テキストも
    接続する直線も無い)は採用しない。
    Returns: {value: match_count}
    """
    groups: dict[float, list[float]] = {}
    grp_keys: list[float] = []
    for val, y, _ang in group_nums_y:
        placed = False
        for rep_y in grp_keys:
            if abs(y - rep_y) <= _SUBSUM_VALIDATE_Y_TOL:
                groups[rep_y].append(val)
                placed = True
                break
        if not placed:
            grp_keys.append(y)
            groups[y] = [val]

    def _is_isolated(tx: float, ty: float) -> bool:
        for _v2, x2, y2, _a2 in target_nums_y:
            if abs(y2 - ty) <= _SUBSUM_VALIDATE_Y_TOL and x2 != tx:
                return False
        for ln in tdf.lines:
            y_avg = (ln.y1 + ln.y2) / 2
            if abs(y_avg - ty) <= _SUBSUM_VALIDATE_Y_TOL and (
                abs(ln.x1 - tx) <= 50 or abs(ln.x2 - tx) <= 50
            ):
                return False
        return True

    def _dist_horiz(ang_deg: float) -> float:
        am = ang_deg % 180
        return min(am, 180 - am)

    text_entries = [(v, x, y) for v, x, y, ang in target_nums_y if _dist_horiz(ang) <= 0.1]
    match_counts: dict[float, int] = {}
    for rep_y, vals in groups.items():
        if len(vals) < 2:
            continue
        group_sum = sum(vals)
        if group_sum < _SUBSUM_MIN_SUM:
            continue
        tol = max(2.0, group_sum * 0.001)
        ranked = sorted(
            (abs(tv - group_sum), tv, tx, ty)
            for tv, tx, ty in text_entries if abs(tv - group_sum) <= tol
        )
        best_tv = None
        for _diff, tv, tx, ty in ranked:
            if _is_isolated(tx, ty):
                continue
            best_tv = tv
            break
        if best_tv is not None:
            match_counts[best_tv] = match_counts.get(best_tv, 0) + 1
    return match_counts


def _line_length_frequency_no_size(tdf: tb.TdfData, x_min: float, x_max: float,
                                    candidates) -> dict[float, int]:
    """候補値ごとに、[x_min, x_max]内に完全に収まる(両端点とも範囲内)、
    長さがほぼ一致(±0.1)する直線の本数を数える。

    サブ寸法和検証(合計が別のテキストと一致するか)が使えない場合の
    フォールバック: ある数値がそのまま梁の全長を表す単一ラベルであり、
    かつ実際に同じ長さの直線が複数本(基準線・上端線・下端線等)存在する
    ケースを拾う(N-1 2G-10で確認: 全長9035が分解されないラベルとして
    1回だけ書かれ、同じ長さの水平線が9本ある)。
    """
    counts: dict[float, int] = {}
    for v in candidates:
        c = 0
        for ln in tdf.lines:
            if abs(ln.length - v) > 0.1:
                continue
            lo, hi = min(ln.x1, ln.x2), max(ln.x1, ln.x2)
            if lo < x_min or hi > x_max:
                continue
            c += 1
        if c > 0:
            counts[v] = c
    return counts


def determine_length_no_size(tdf: tb.TdfData, x_min: float, x_max: float, y_ref: float):
    """3項目パターン専用の長さ判定。DXF抽出アプリの「サブ寸法和+直線連結性の
    検証」を移植したもの(既存のdetermine_lengthとは独立、互いに影響しない)。

    サブ寸法和で一意に決まらない場合、同一長さ直線の頻度によるフォールバック
    (`_line_length_frequency_no_size`)を試みる。それでも一意に決まらない
    場合はNoneを返す(2026-09-16、N-1 2G-10対応で追加)。

    Returns: (length_value or None, debug dict)
    """
    all_nums_xy = _collect_horiz_nums_no_size(tdf, x_min, x_max, y_ref)
    group_nums_y = _filter_connected_nums_no_size(tdf, all_nums_xy)
    match_counts = _bottom_up_validate_no_size(tdf, group_nums_y, all_nums_xy)

    debug = {"all_nums_count": len(all_nums_xy), "match_counts": match_counts}

    length_value = None
    if match_counts:
        max_c = max(match_counts.values())
        top = [v for v, c in match_counts.items() if c == max_c]
        if len(top) == 1:
            length_value = top[0]

    if length_value is None:
        candidates = {
            v for v, _x, _y, ang in all_nums_xy
            if v >= _LINE_FREQ_MIN_VALUE and (abs(ang % 180 - 0) <= 0.1 or abs(ang % 180 - 180) <= 0.1)
        }
        freq = _line_length_frequency_no_size(tdf, x_min, x_max, candidates)
        debug["line_freq"] = freq
        if freq:
            max_fc = max(freq.values())
            top_f = [v for v, c in freq.items() if c == max_fc]
            if max_fc >= _LINE_FREQ_MIN_COUNT and len(top_f) == 1:
                length_value = top_f[0]
                debug["reason"] = "line frequency fallback"

    if length_value is None:
        return None, {**debug, "reason": debug.get("reason", "no sub-sum match / no line-frequency match")}

    # 種別(普通梁/斜め梁)判定用に、確定した長さに一致する参照直線の角度を求める。
    # tdf_master_extractor_multiは本モジュールをimportしているため、循環import
    # を避けるためここでは関数内でローカルimportする。
    import tdf_master_extractor_multi as exm
    endpoints = exm._find_reference_line_endpoints(tdf, x_min, x_max, y_ref, None, length_value)
    main_axis_deg = None
    if endpoints is not None:
        (lx, ly), (rx, ry) = endpoints
        main_axis_deg = math.degrees(math.atan2(ry - ly, rx - lx))
    debug["main_axis_deg"] = main_axis_deg
    debug["endpoints"] = endpoints
    return length_value, debug


def _nearest_size_text_no_size(tdf: tb.TdfData, cx: float, cy: float):
    """(cx, cy)に最も近いサイズらしきテキストを返す(絶対閾値なし。
    DXFアプリのnearest_sizeと同じ考え方)。"""
    best = None
    best_d = float("inf")
    for r in tdf.texts:
        text = tdf.resolve_text(r)
        if not text or not _looks_like_size(text):
            continue
        d = math.hypot(r.x - cx, r.y - cy)
        if d < best_d:
            best_d = d
            best = (r.x, r.y, text)
    return best


def _find_stadium_capsules_no_size(tdf: tb.TdfData, angle_tol_deg: float = 1.0,
                                    radius_tol: float = 0.5, max_dist_factor: float = 20.0):
    """`find_stadium_centers`と同じペアリングロジックだが、中点だけでなく
    2つの円弧中心そのもの(カプセルの両端点)も返す(既存のfind_stadium_centers
    は変更せず、こちらは独立実装)。

    2026-09-16、KIX01現場`N-1 2G-06`で、継手記号(半径57.0)とは別に、
    フランジ沿いのボルト穴らしき小さい円弧ペア(半径4.6)も同じ条件を
    満たしてしまい、「中心に最も近いテキスト」方式では継手と無関係な
    テキストを誤って拾う問題が見つかった。実際に長丸(カプセル)の中に
    テキストが入っているかで判定するには、中点だけでなく2端点(カプセルの
    軸)が必要なため、この専用版を追加した。

    Returns: [(ax, ay, bx, by, r), ...]
    """
    arcs = [a for a in tdf.arcs if a.a1 is not None]
    pairs = []
    used = set()
    n = len(arcs)
    for i in range(n):
        a = arcs[i]
        if a.offset in used:
            continue
        for j in range(i + 1, n):
            b = arcs[j]
            if b.offset in used:
                continue
            if abs(a.r - b.r) > radius_tol:
                continue
            a1d = math.degrees(a.a1)
            b1d = math.degrees(b.a1)
            diff = abs((a1d - b1d) % 360)
            diff = min(diff, 360 - diff)
            if abs(diff - 180.0) > angle_tol_deg:
                continue
            dist = math.hypot(b.cx - a.cx, b.cy - a.cy)
            if not (0.1 < dist < a.r * max_dist_factor):
                continue
            pairs.append((a.cx, a.cy, b.cx, b.cy, a.r))
            used.add(a.offset)
            used.add(b.offset)
            break
    return pairs


def _point_in_capsule_no_size(px: float, py: float, ax: float, ay: float,
                               bx: float, by: float, r: float) -> bool:
    """点(px,py)がカプセル(2端点ax,ay〜bx,by・半径r)の中に入っているかを判定する。"""
    dx, dy = bx - ax, by - ay
    seg_len2 = dx * dx + dy * dy
    if seg_len2 == 0:
        return math.hypot(px - ax, py - ay) <= r
    t = ((px - ax) * dx + (py - ay) * dy) / seg_len2
    t = max(0.0, min(1.0, t))
    cx, cy = ax + t * dx, ay + t * dy
    return math.hypot(px - cx, py - cy) <= r


def _text_enclosed_by_capsule_no_size(tdf: tb.TdfData, rec, capsule) -> bool:
    """テキストの開始点・終了点(幅×文字数から計算)のどちらかがカプセルの
    中に入っていればTrue(2026-09-16、ユーザー指摘: テキストは点ではなく
    範囲を持つため、開始点だけ/終了点だけがカプセルに入っているケースも
    正しく拾う必要がある)。"""
    text = tdf.resolve_text(rec)
    if not text:
        return False
    ax, ay, bx, by, r = capsule
    if _point_in_capsule_no_size(rec.x, rec.y, ax, ay, bx, by, r):
        return True
    rot = tdf.resolve_rot(rec)
    total_w = rec.w * len(text)
    end_x = rec.x + total_w * math.cos(rot)
    end_y = rec.y + total_w * math.sin(rot)
    return _point_in_capsule_no_size(end_x, end_y, ax, ay, bx, by, r)


def determine_joints_no_size(tdf: tb.TdfData, y_ref: float, length_value: float, endpoints,
                              y_max: float | None = None):
    """3項目パターン専用の継手判定。確定した長さに一致する参照直線の実端点
    (endpoints、determine_length_no_sizeのdebug['endpoints']をそのまま渡す)
    それぞれについて、**実際に長丸(カプセル)に囲まれているテキスト**だけを
    候補にし、その中で最も近いものを左右継手として採用する(絶対閾値は
    設けない)。

    2026-09-16、KIX01現場`N-1 2G-06`で「長丸の中心に最も近いテキスト」
    方式だと、継手記号とは無関係な小さい円(ボルト穴等)の方が近く、
    無関係なテキストを誤って拾う不具合が見つかったため、「カプセルに
    実際に囲まれているか」で候補を絞り込む方式に改訂した。

    `y_max`を指定すると、段(tier)が2段以上ある図面で、自分の段より上に
    ある別の段の継手候補を除外する(2026-09-16、S-1 R1G-03対応。後述の
    X軸のみでの距離判定に切り替えたことで、Y方向の距離という暗黙の段
    分離効果が失われたため、明示的なY範囲の打ち切りが別途必要になった)。

    Returns: (left_text, right_text, left_center, right_center)
             継手候補が1つも無い場合は (None, None, None, None)
    """
    if endpoints is None:
        return None, None, None, None
    (lx, ly), (rx, ry) = endpoints

    # 2026-09-16、S-1 R1G-06(屋根梁、主軸が約0.6度傾いている)で、継手ラベル
    # 自身も同じ0.6度回転して描かれていたため「回転角がちょうど0度」という
    # 事前フィルタに一致せず、無関係な回転0度の別継手(BJ12)が誤って採用
    # されていた。カプセル内包判定(_text_enclosed_by_capsule_no_size)自体は
    # テキストの回転を考慮して始点・終点を計算する実装のため、この事前
    # フィルタ自体が不要かつ有害(ユーザー承認済み、N-1 2G回帰11行に影響
    # ないことを確認済み)。
    capsules = [
        c for c in _find_stadium_capsules_no_size(tdf)
        if (c[1] + c[3]) / 2 > y_ref and (y_max is None or (c[1] + c[3]) / 2 < y_max)
    ]
    candidates = []  # (mid_x, mid_y, text)
    for ax, ay, bx, by, r in capsules:
        for rec in tdf.texts:
            if not _text_enclosed_by_capsule_no_size(tdf, rec, (ax, ay, bx, by, r)):
                continue
            candidates.append(((ax + bx) / 2, (ay + by) / 2, tdf.resolve_text(rec)))
            break  # 1つのカプセルには通常1つのテキストしか描かれていない

    if not candidates:
        return None, None, None, None

    # 2026-09-16、S-1 R1G-14〜16で、全長の寸法線が実際の部材・継手位置から
    # Y方向に大きくオフセットされた「見やすさのための注記段」に描かれていた
    # ため、その寸法線の実端点との2次元距離で継手候補を探すと、Y位置がたまたま
    # その注記段に近い無関係な継手(BJ12)を誤って拾ってしまっていた。
    # ユーザー指摘: 継手の判定は「マーク群より上の範囲で、長さの左端X〜右端X
    # (斜め梁ならその勾配に沿って)付近にある長丸テキスト」であるべきで、
    # 寸法線自体のY位置に依存すべきではない。実端点のY座標を無視し、主軸の
    # 傾きに沿って回転させたX座標だけで最も近いものを選ぶ(Y方向の距離は
    # 見た目上の都合でいくらでも離れうるため無視してよい)。
    main_axis_deg = math.degrees(math.atan2(ry - ly, rx - lx))
    theta = -math.radians(main_axis_deg)

    def _rotate_x(x: float, y: float) -> float:
        return x * math.cos(theta) - y * math.sin(theta)

    lx_r = _rotate_x(lx, ly)
    rx_r = _rotate_x(rx, ry)

    def _nearest(target_xr: float):
        return min(candidates, key=lambda c: abs(_rotate_x(c[0], c[1]) - target_xr))

    left_cx, left_cy, left_text = _nearest(lx_r)
    right_cx, right_cy, right_text = _nearest(rx_r)
    return (
        left_text, right_text,
        {"cx": left_cx, "cy": left_cy},
        {"cx": right_cx, "cy": right_cy},
    )


def _char_multiset_overlap_no_size(a: str, b: str) -> int:
    """2つの文字列の「1文字ずつの多重集合」としての共通部分の個数を返す。
    サイズ表記(例: H-900x300x16x28)同士の類似度の簡易指標として使う。"""
    ca = collections.Counter(a)
    cb = collections.Counter(b)
    return sum((ca & cb).values())


def determine_size_no_size(tdf: tb.TdfData, endpoints, left_jobj, right_jobj):
    """3項目パターン専用のサイズ判定。左右継手位置に最も近いサイズ文字列を
    探し、それが長さのX範囲(endpointsのX最小〜最大)の外側にあれば
    「継手側(接続先部材)のサイズ」とみなし(DXFアプリのis_joint_size)、
    そのY座標帯(±300)・長さのX範囲内で改めて候補を探す。

    候補が単一ならそれを採用。複数件の場合は、継手側サイズ(refs)との
    1文字多重集合の一致数が最も多い候補を採用する(DXFアプリのフォールバック
    と同じ考え方: 断面形状記号や寸法が近い側が本体サイズである可能性が高い)。
    一致数が同点の場合や候補0件の場合はNoneを返す。
    """
    if endpoints is None:
        return None
    (lx, _ly), (rx, _ry) = endpoints
    x_lo, x_hi = min(lx, rx), max(lx, rx)

    def _is_joint_size(pos) -> bool:
        return not (x_lo <= pos[0] <= x_hi)

    size_l = _nearest_size_text_no_size(tdf, left_jobj["cx"], left_jobj["cy"]) if left_jobj else None
    size_r = _nearest_size_text_no_size(tdf, right_jobj["cx"], right_jobj["cy"]) if right_jobj else None
    refs = [p for p in (size_l, size_r) if p is not None and _is_joint_size(p)]
    if not refs:
        return None

    y_lo = min(p[1] for p in refs) - _SIZE_JOINT_Y_BAND
    y_hi = max(p[1] for p in refs) + _SIZE_JOINT_Y_BAND
    exclude_xy = {(p[0], p[1]) for p in refs}

    values = set()
    for r in tdf.texts:
        text = tdf.resolve_text(r)
        if not text or not _looks_like_size(text):
            continue
        if (r.x, r.y) in exclude_xy:
            continue
        if not (x_lo <= r.x <= x_hi and y_lo <= r.y <= y_hi):
            continue
        values.add(text)

    if len(values) == 1:
        return next(iter(values))
    if len(values) > 1:
        ref_texts = [p[2] for p in refs]
        scored = sorted(
            (
                (max(_char_multiset_overlap_no_size(v, rt) for rt in ref_texts), v)
                for v in values
            ),
            key=lambda item: item[0],
            reverse=True,
        )
        if len(scored) >= 2 and scored[0][0] == scored[1][0]:
            return None
        return scored[0][1]
    return None


# ---------------------------------------------------------------------------
# 「製品マーク|設計符号|本数」3項目パターン専用: 隣接製品との直線連結による
# 長さ候補の絞り込み(2026-09-16、S-1 R1G-07〜10対応)
# ---------------------------------------------------------------------------
#
# 1枚の図面に2製品の寸法チェーンが連結して描かれているケース(例:
# R1GX2Y1[9491.2]とR1GX2Y1a[11480]が同じ全体寸法線の続きとして描かれている)
# で、単純な「範囲内で一致する直線の本数が多い方を採用」という判定だと、
# 無関係な繰り返し寸法(重複コピーが複数存在する値)の方が本数で勝ってしまう
# ことがあった。ユーザー指摘: 「隣接製品の長さが確定している場合、その直線と
# 同じ角度で繋がっている(端点が一致する)直線を持つ候補を優先すべき」。
#
# 「重複コピーが無い、単独の直線」だけに絞って端点の連結を見ることで、
# 繰り返し寸法(常に複数コピーが存在する)を自然に除外できる。
_SINGULAR_LINE_Y_TOL = 100.0  # 同じ長さの直線が近いYに複数あるかの判定幅
_CONNECT_POINT_TOL = 50.0     # 隣接製品の直線と端点が繋がっているとみなす距離
_CONNECT_ANGLE_TOL = 3.0      # 端点連結を認める角度差(度)
_AMBIGUOUS_MATCH_MAX = 3      # この一致直線数以下(かつprimary_cnt=0)の場合のみ連結判定を試みる


def _is_singular_length_line(tdf: tb.TdfData, ln, value: float, y_tol: float = _SINGULAR_LINE_Y_TOL) -> bool:
    ty = (ln.y1 + ln.y2) / 2
    count = 0
    for other in tdf.lines:
        if abs(other.length - value) > 0.5:
            continue
        oy = (other.y1 + other.y2) / 2
        if abs(oy - ty) < y_tol:
            count += 1
    return count == 1


def _singular_lines_for_value(tdf: tb.TdfData, value: float) -> list:
    cands = [ln for ln in tdf.lines if abs(ln.length - value) < 0.5]
    return [ln for ln in cands if _is_singular_length_line(tdf, ln, value)]


def _line_angle_deg(ln) -> float:
    return math.degrees(math.atan2(ln.y2 - ln.y1, ln.x2 - ln.x1)) % 180


def _connected_length_candidate(tdf: tb.TdfData, candidates: list, sibling_length: float) -> float | None:
    """候補値のうち、隣接製品(sibling_length、確定済み)の「単独直線」と端点が
    繋がっている「単独直線」を持つものを返す(無ければNone)。candidatesは
    determine_lengthのdebug['candidates'](val, a, b, primary_cnt)のリスト。"""
    sib_lines = _singular_lines_for_value(tdf, sibling_length)
    if not sib_lines:
        return None
    best_val = None
    best_dist = float("inf")
    for val, _a, _b, _primary in candidates:
        cand_lines = _singular_lines_for_value(tdf, val)
        for cln in cand_lines:
            for sln in sib_lines:
                for px, py in ((cln.x1, cln.y1), (cln.x2, cln.y2)):
                    for qx, qy in ((sln.x1, sln.y1), (sln.x2, sln.y2)):
                        dist = math.hypot(px - qx, py - qy)
                        if dist > _CONNECT_POINT_TOL:
                            continue
                        diff = abs(_line_angle_deg(cln) - _line_angle_deg(sln))
                        diff = min(diff, 180 - diff)
                        if diff > _CONNECT_ANGLE_TOL:
                            continue
                        if dist < best_dist:
                            best_dist = dist
                            best_val = val
    return best_val


# ---------------------------------------------------------------------------
# 「製品マーク|設計符号|本数」3項目パターン専用: 端点連結した直線群の合計長
# による長さ候補の絞り込み(2026-09-16、S-1 R1G-14〜16対応)
# ---------------------------------------------------------------------------
#
# S-1 R1G-14で、正解の全長(10480.6)には対応する数値テキストラベルが1つしか
# 無く、その1本の直線に対する一致本数(a=1)では、別の無関係な値(12900.0、
# これも1本)と決着がつかなかった。ユーザー提案: 「寸法線(の合計)が候補の
# 数値テキストと一致し、その一致(合計)が複数系統で成立するものを優先する」。
#
# 実際に調べたところ、10480.6は「2465.24+3625.11+4390.25」という、個別には
# 数値ラベルの無い(直線だけの)3本の連結チェーンの合計と一致し、しかも
# こうした独立した合計の系統(重複して描かれた別のYの控え線群)が4つ見つかった
# (12900.0は3つ)。この「合計が一致する連結チェーンの本数」を数え、既存の
# 候補(determine_lengthが既に検出した数値テキスト)の中で最も多い系統数を
# 持つものを優先する。
_CHAIN_MIN_SEG_LEN = 500.0   # 直線チェーンを構成する最小の直線長(ボルト・矢印等の
                              # 極小ノイズを除外)
_CHAIN_CONNECT_TOL = 30.0    # チェーンとみなす端点同士の距離
_CHAIN_ANGLE_TOL = 5.0       # ほぼ水平とみなす角度差(度、既存のline角度判定と同程度)
_CHAIN_SUM_TOL = 1.0         # 合計とテキスト候補値が一致するとみなす誤差
_CHAIN_MIN_WIN_COUNT = 2     # この系統数以上、かつ他候補より厳密に多い場合のみ採用


def _chain_sum_counts(tdf: tb.TdfData, y_ref: float, y_max: float | None = None) -> dict[float, int]:
    """y_ref(行のY)より上・(y_maxがあればそれより下)にあるほぼ水平な直線
    (_CHAIN_MIN_SEG_LEN以上)を対象に、端点が連結している(_CHAIN_CONNECT_TOL以内)
    グループを求め、2本以上のグループについて合計長を集計する。
    戻り値: {合計長(丸め): 出現した連結グループの数}
    """
    lines = []
    for ln in tdf.lines:
        ang = math.degrees(math.atan2(ln.y2 - ln.y1, ln.x2 - ln.x1)) % 180
        if min(ang, 180 - ang) > _CHAIN_ANGLE_TOL:
            continue
        if ln.y1 <= y_ref or ln.y2 <= y_ref:
            continue
        if y_max is not None and (ln.y1 >= y_max or ln.y2 >= y_max):
            continue
        if ln.length < _CHAIN_MIN_SEG_LEN:
            continue
        lines.append(ln)

    n = len(lines)
    parent = list(range(n))

    def _find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def _union(a, b):
        parent[_find(a)] = _find(b)

    pts = [((ln.x1, ln.y1), (ln.x2, ln.y2)) for ln in lines]
    for i in range(n):
        for j in range(i + 1, n):
            for p in pts[i]:
                for q in pts[j]:
                    if math.hypot(p[0] - q[0], p[1] - q[1]) <= _CHAIN_CONNECT_TOL:
                        _union(i, j)

    groups: dict[int, list] = {}
    for i, ln in enumerate(lines):
        groups.setdefault(_find(i), []).append(ln)

    counts: dict[float, int] = {}
    for members in groups.values():
        if len(members) < 2:
            continue
        total = round(sum(m.length for m in members), 1)
        counts[total] = counts.get(total, 0) + 1
    return counts


def _chain_sum_candidate(tdf: tb.TdfData, row: ProductRow, candidates: list, y_max: float | None = None) -> float | None:
    """候補値のうち、連結直線チェーンの合計として最も多くの系統で裏付けられる
    ものを返す(他候補より厳密に多く、かつ_CHAIN_MIN_WIN_COUNT以上の場合のみ。
    そうでなければNone)。"""
    counts = _chain_sum_counts(tdf, row.y, y_max)
    scored = []
    for val, _a, _b, _primary in candidates:
        cnt = sum(c for cv, c in counts.items() if abs(cv - val) < _CHAIN_SUM_TOL)
        scored.append((val, cnt))
    scored.sort(key=lambda t: -t[1])
    if len(scored) < 2:
        return None
    best_val, best_cnt = scored[0]
    second_cnt = scored[1][1]
    if best_cnt >= _CHAIN_MIN_WIN_COUNT and best_cnt > second_cnt:
        return best_val
    return None


def extract(path: str) -> list[ProductRow]:
    tdf = tb.load(path)
    drawing_number = find_drawing_number(tdf)
    rows = find_product_rows(tdf)

    for i, row in enumerate(rows):
        if len(rows) == 1:
            # 製品が1種類だけの図面は、他の製品との取り違えリスクが無いため
            # X範囲を左右5000mmずつ緩和し、長さ候補の見落としを減らす。
            x_min = row.x_mark - RELAX_MARGIN
            x_max = row.x_next + RELAX_MARGIN
        else:
            x_min = row.x_mark
            x_max = row.x_next
        y_ref = row.y
        length_value, debug = determine_length(tdf, x_min, x_max, y_ref)
        row.length = length_value
        if length_value is not None:
            main_axis_deg = debug.get("main_axis_deg", 0.0)
            # 継手判定は緩和前の製品自身のマーク/本数セル座標を基準にする
            # (緩和後のx_min/x_maxを使うと、判定基準点が製品本体から
            # 大きくずれて別の候補を誤って拾ってしまう)。
            left, right = determine_joints(
                tdf, row.x_mark, row.x_next, y_ref, main_axis_deg, length_value
            )
            row.left_joint = left
            row.right_joint = right
        row.drawing_number = drawing_number

    return rows


if __name__ == "__main__":
    import sys

    if len(sys.argv) != 2:
        print("使い方: python tdf_master_extractor.py <tdfパス>")
        raise SystemExit(1)

    rows = extract(sys.argv[1])
    dn = find_drawing_number(tb.load(sys.argv[1]))
    print(f"図番: {dn}")
    for r in rows:
        print(f"  製品マーク={r.mark} 設計符号={r.design_code} サイズ={r.size} "
              f"本数={r.count} 重量={r.weight} 長さ={r.length} "
              f"左継手={r.left_joint} 右継手={r.right_joint}")
