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
import unicodedata
from dataclasses import dataclass

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
# 2026-10-29、N2B-36〜42の間柱`2L-75x75x9`(L形鋼2枚)を追加。サイズと
# 認識されず「マーク|設計符号|本数」の3項目の表として1列ずれて読まれていた。
# 2026-11-09、26-16 EB3-EVM1B-04 の角形鋼管`□-100x100x3.2`を追加。同じく
# 3項目の表として読まれ、製品マーク以降が1列ずれていた。
# 2026-11-09、26-12 2B-81 のブレース`2LS-75x75x6`(L形鋼2枚)を追加。同じく
# 1列ずれていた。
SIZE_PATTERN = re.compile(
    r"^(2LS|2L|BBOX|BCP|BCR|BOX|BH|BT|CT|C|MHY|HFT|HYT|HF|HY|H|I|LH|L|P|SH|TH|[0-9]+φ|\[|角|□)[\-‐]?\s*[0-9]"
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
    # この行だけ、継手・サイズの判定を別の専用ロジック(determine_joints_no_size等)に
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
        # 設計符号とサイズの間に1文字の書き込み(26-16 WB1-2G-03 の「N」「Ｂ」)が
        # あると、それを製品マーク・設計符号と取り違える。1文字の文字を飛ばして
        # 左に2つ残るときだけ、その2つを製品マーク・設計符号にする。
        before = [r for r in same_row[:-1] if len(tdf.resolve_text(r).strip()) > 1]
        if len(before) >= 2 and len(before) < len(same_row) - 1:
            code_rec, mark_rec = before[-1], before[-2]
        size_text = tdf.resolve_text(size_rec)
        if not _looks_like_size(size_text):
            continue
        # 製品マークの位置に「N台」(隣の表の本数)が来たものは製品の行ではない
        # (26-16 の EA1-2B-06: 製品マークが行から下にずれて書かれ、左の表の「1台」を
        # 製品マークと読んでいた。ITM.xlsx の照合で判明)。find_product_rows_offset_mark で読む。
        if tb.is_dai_cell(tdf.resolve_text(mark_rec)):
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


OFFSET_MARK_DY = 130.0  # 製品マークが本数の行からずれて書かれていてもよい上下の幅(行の間隔240の約半分)
_MARK_LIKE = re.compile(r"^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$")


def find_product_rows_offset_mark(
    tdf: tb.TdfData, existing_positions: set[tuple[float, float]] | None = None,
) -> list[ProductRow]:
    """製品マークが本数の行から少し上下にずれて書かれた行(ほかの読み方で使われなかった
    「N台」だけを対象にする)。

    26-16 の EA1-2B-06: EA12-2B35-51〜54 の製品マークが「1台」の行より60下に書かれ、
    同じ行の文字として読めず、4製品が抜けていた(ITM.xlsx の照合で判明)。-53・-54 は
    2行で設計符号・サイズを共有し、その文字は2行の真ん中(120ずれ)にある。

    「N台」から左へ、同じ高さの直前の「N台」より右の範囲で、上下 OFFSET_MARK_DY 以内の
    文字を見る。サイズの文字とその左の設計符号(サイズと同じ高さ)があり、さらに左で一番
    近い製品マークらしい文字(英数字とハイフン)を製品マークにする。
    """
    existing_positions = existing_positions or set()
    dais = [r for r in tdf.texts if r.rot == 0 and tdf.resolve_text(r) and tb.is_dai_cell(tdf.resolve_text(r))]
    rows: list[ProductRow] = []
    for dai in dais:
        if (round(dai.x, 1), round(dai.y, 1)) in existing_positions:
            continue
        prev_x = max((d.x for d in dais if d.x < dai.x and abs(d.y - dai.y) < SAME_ROW_Y_TOLERANCE), default=None)
        win = [r for r in tdf.texts
               if r.rot == 0 and r.x < dai.x and (prev_x is None or r.x > prev_x)
               and abs(r.y - dai.y) <= OFFSET_MARK_DY and tdf.resolve_text(r)
               and not tb.is_dai_cell(tdf.resolve_text(r))]
        sizes = [r for r in win if _looks_like_size(tdf.resolve_text(r))]
        if not sizes:
            continue
        size_rec = min(sizes, key=lambda r: (abs(r.y - dai.y), -r.x))
        codes = [r for r in win if r.x < size_rec.x and abs(r.y - size_rec.y) < SAME_ROW_Y_TOLERANCE]
        if not codes:
            continue
        code_rec = max(codes, key=lambda r: r.x)
        marks = [r for r in win if r.x < code_rec.x and r is not size_rec
                 and _MARK_LIKE.match(unicodedata.normalize("NFKC", tdf.resolve_text(r)).strip())
                 and not _looks_like_size(tdf.resolve_text(r))]
        if not marks:
            continue
        mark_rec = max(marks, key=lambda r: r.x)
        # 製品マークは、同じ列の「N台」のうちこの「N台」に一番近いこと(2行の表で取り違えない)
        col = [d for d in dais if abs(d.x - dai.x) < 1.0]
        if min(col, key=lambda d: abs(d.y - mark_rec.y)) is not dai:
            continue
        rows.append(ProductRow(
            mark=tdf.resolve_text(mark_rec), design_code=tdf.resolve_text(code_rec),
            size=tdf.resolve_text(size_rec), count=tdf.resolve_text(dai), weight=None,
            x_mark=mark_rec.x, x_next=dai.x, y=dai.y,
        ))
    rows.sort(key=lambda r: r.x_mark)
    return rows


_H_TYPE_PREFIX = re.compile(r"^(2LS|2L|BBOX|BCP|BCR|BOX|BH|BT|CT|C|MHY|HFT|HYT|HF|HY|H|I|LH|L|SH|TH)")


def _is_code_not_size(text: str) -> bool:
    """H形鋼などの接頭辞で始まるが、「x」(寸法の区切り)が無い文字は、サイズでなく設計符号。
    (2026-11-11、26-17 B1M2B-05。設計符号「TH441」がサイズの書き方「TH-441x…」と同じ形とみなされ、
    製品の行が読み飛ばされて0行になった。サイズには必ず幅や厚さの「x」が入る。)"""
    t = unicodedata.normalize("NFKC", text).strip()
    return bool(_H_TYPE_PREFIX.match(t)) and not re.search(r"[xX×*]", t)


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
        if _looks_like_size(code_text) and not _is_code_not_size(code_text):
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


_FILENAME_SEPARATORS = (" ", "　", "_", "(", "（")


def _drawing_number_from_filename(tdf: tb.TdfData, filename: str) -> str | None:
    """ファイル名の先頭と一致する図面の文字を図番として返す。

    ファイル名が「1C-01　261023.tdf」のように図番で始まるとき、図面の文字の中から
    ファイル名の先頭(全体、または区切り文字の直前まで)と一致するものを探す。
    返すのは図面に書かれた文字で、ファイル名そのものは図番にしない。
    一致する文字が複数あれば長いものを優先し、同じ長さなら右下(表題欄の側)に
    近いものを採る。一致が無ければNoneを返し、従来の判定に任せる。

    2026-11-02、26-12 C棟の柱詳細図1C-01で、表題欄に「図面番号」ラベルが無く、
    図番「1C-01」が数字で始まるため候補にならず、階の名前「CB1FL」を図番として
    いた問題を受けて追加。"""
    stem = filename.replace("\\", "/").rsplit("/", 1)[-1]
    if stem.lower().endswith(".tdf"):
        stem = stem[:-4]
    stem = stem.strip()
    matches = []
    for r in tdf.texts:
        if r.text is None or r.rot != 0:
            continue
        t = r.text.strip()
        if not t or t.isdigit() or not stem.startswith(t):
            continue
        if len(stem) > len(t) and not stem[len(t)].startswith(_FILENAME_SEPARATORS):
            continue
        matches.append(r)
    if not matches:
        return None
    matches.sort(key=lambda r: (-len(r.text.strip()), -r.x, r.y))
    return matches[0].text.strip()


def find_drawing_number(tdf: tb.TdfData, filename: str | None = None) -> str | None:
    """タイトル欄の図番らしきテキストを推定する。

    ファイル名が渡されたときは、ファイル名の先頭と一致する図面の文字を最優先する
    (_drawing_number_from_filename)。

    まず「図面番号」ラベル(4文字が連続して並ぶ箇所)を探し、その近く
    (Y座標の差が500mm以内)にある英数字+ハイフンの候補の中で、ラベルに
    最もX方向で近いものを図番として採用する。ラベルが見つからない場合や
    近くに候補が無い場合は、従来通り文字高さが最も大きいものを採用する
    (フォールバック)。

    2026-09-14、鳥取現場図面EA1-1G-14で、製品テーブルの「設計符号」欄が
    たまたまタイトル欄の図番と同じ文字高さだったため誤って設計符号の方を
    採用してしまう問題が発覚し、位置情報(ラベルとの近さ)を優先する方式に
    改訂した。"""
    if filename:
        from_name = _drawing_number_from_filename(tdf, filename)
        if from_name is not None:
            return from_name

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
# 「製品マーク|設計符号|本数(N台)」3項目パターン(サイズ省略)専用の
# 継手・サイズ判定
# ---------------------------------------------------------------------------
#
# find_product_rows_no_size()が見つけた行(ProductRow.size_missing=True)だけを
# 対象にする(2026-09-16、KIX01現場`N-1 2G-05`対応で追加)。
#   - 継手: 確定した長さと一致する直線の実端点(_find_reference_line_endpoints)の
#     近傍にある長丸のうち、各端点に最も近いものを採用する。
#   - サイズ: 各継手位置に最も近いサイズ文字列が長さのX範囲の外側にあれば
#     「継手側(接続先部材)のサイズ」とみなし、そのY座標帯(±_SIZE_JOINT_Y_BAND)・
#     長さのX範囲内で改めて探した単一候補を採用する。
#
# 2026-11-09: この節の長さ判定(determine_length_no_size と補助関数)と、
# 旧来の「GJ始まり」の継手判定(determine_joints・find_stadium_centers)、
# 単独実行用の extract() は、アプリから呼ばれていなかったので削除した。

# 製品が1種類だけの図面で、長さを探すX範囲を左右に広げる幅(tdf_app から使う)
RELAX_MARGIN = 5000.0
_SIZE_JOINT_Y_BAND = 300.0
_JOINT_END_X = 1200.0  # 継手の高さを比べるとき、梁の端からX方向にこの範囲の長丸だけを使う
_JOINT_LEVEL_TOL = 60.0  # 継手の長丸の高さの違いがこれ以内なら、同じ高さに描かれたものとみなす
_JOINT_IN_MAX = 200.0  # 梁の端より内側に、継手の長丸の中心がこれ以上入っていたら、その端の継手にしない
_JOINT_Y_NEAR = 600.0  # 継手の長丸を、長さの基準線のこの上下の範囲から優先して選ぶ


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
    """長丸(半径一致・開始角180度差の円弧ペア)を探し、中点だけでなく
    2つの円弧中心そのもの(カプセルの両端点)も返す。

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
    (endpoints、左右端点の(x, y))
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

    # 長さの基準線の近く(上下600以内)に、左右の端それぞれの側の長丸があれば、そちらだけから選ぶ
    # (2026-11-11、26-17 B1M2G-01 の 2G12: 梁の中ほどに付く別の部材の継手 BTJB の方がXでは近く、
    # 梁の端の J7207A を選べなかった)。左右どちらかの側に無いときは今までどおり全部から選ぶ
    # (全長の寸法線が離れた位置に描かれた図面。S-1 R1G-14〜16)。
    mid_xr = (lx_r + rx_r) / 2.0
    ref_y = (ly + ry) / 2.0
    near = [c for c in candidates if abs(c[1] - ref_y) <= _JOINT_Y_NEAR]
    # 梁の端より内側に200以上入った長丸は、その端の継手にしない(2026-11-11、26-17 D1MM2G-01。
    # 右端より559内側にある別の梁の PJ340 を、右端の継手に選んでいた。正しい継手は端の外側に付く)
    left_near = [c for c in near if _rotate_x(c[0], c[1]) < mid_xr and _rotate_x(c[0], c[1]) <= lx_r + _JOINT_IN_MAX]
    right_near = [c for c in near if _rotate_x(c[0], c[1]) >= mid_xr and _rotate_x(c[0], c[1]) >= rx_r - _JOINT_IN_MAX]
    if left_near and right_near:
        # 基準線に最も近い高さに描かれた長丸だけにする(2026-11-11、26-17 D1M3G-03・-06。基準線の上下600に
        # 別の部材の継手 BTJB(427上)と梁の継手 J7207A(350下)があり、X方向では BTJB の方が近かった)。
        # 左右の側がそろうときだけ絞る。
        # (端から X方向に1200以内にある長丸だけで高さを比べる。遠くの別の部材の長丸は含めない)
        l_end = [c for c in left_near if abs(_rotate_x(c[0], c[1]) - lx_r) <= _JOINT_END_X]
        r_end = [c for c in right_near if abs(_rotate_x(c[0], c[1]) - rx_r) <= _JOINT_END_X]
        near_dy = min(abs(c[1] - ref_y) for c in l_end + r_end) if (l_end and r_end) else None
        ln = [c for c in left_near if near_dy is not None and abs(c[1] - ref_y) <= near_dy + _JOINT_LEVEL_TOL]
        rn = [c for c in right_near if near_dy is not None and abs(c[1] - ref_y) <= near_dy + _JOINT_LEVEL_TOL]
        if ln and rn:
            left_near, right_near = ln, rn
        left_pool, right_pool = left_near, right_near
    elif near:
        # 継手が基準線の近くに描かれている図面で、片側の端の近くには継手が無いとき(その端は継手なし)、
        # 離れた別の部材の継手を選ばない(2026-11-11、26-17 D1MM2G-01。左端に継手が無い梁が、
        # 上の別の部材の HVJ4z を選んでいた)。
        left_pool, right_pool = left_near, right_near
    else:
        left_pool = right_pool = candidates

    def _nearest(target_xr: float, pool):
        if not pool:
            return None, None, None
        c = min(pool, key=lambda c: abs(_rotate_x(c[0], c[1]) - target_xr))
        return c

    left_cx, left_cy, left_text = _nearest(lx_r, left_pool)
    right_cx, right_cy, right_text = _nearest(rx_r, right_pool)
    return (
        left_text, right_text,
        {"cx": left_cx, "cy": left_cy} if left_text is not None else None,
        {"cx": right_cx, "cy": right_cy} if right_text is not None else None,
    )


def _char_multiset_overlap_no_size(a: str, b: str) -> int:
    """2つの文字列の「1文字ずつの多重集合」としての共通部分の個数を返す。
    サイズ表記(例: H-900x300x16x28)同士の類似度の簡易指標として使う。"""
    ca = collections.Counter(a)
    cb = collections.Counter(b)
    return sum((ca & cb).values())


# 継手と同じ高さとみなす幅(3つ目の方法。2026-11-13、26-17 D1MM2B-03・04 の下の図は継手の文字から313・314下に
# 梁のサイズが書かれていた)
_SIZE_NEAR_JOINT_Y_BAND = 400.0


def _has_dims(text: str) -> bool:
    """「H-200x200x8x12」のように寸法が x でつながった文字か。「C100」のような部材の名前だけの文字は
    梁本体のサイズに使わない(2026-11-13、26-17 D1MM2B-03 の D1MM2HB11-1 が上の図の C100 になっていた。
    正解Excelのサイズに x の無いものは無い)。"""
    return bool(re.search(r"\d\s*[xX×*]\s*\d", unicodedata.normalize("NFKC", text)))


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

    # 長さの基準線の近く(上下300以内)・長さのX範囲の中に、サイズの文字がちょうど1種類だけあれば、
    # それが梁本体のサイズ(2026-11-11、26-17 B1M2G-01 の 2G2・2G12。継手の近くのサイズ文字は
    # 継手の途中に付く別の部材 BT-300 等を拾ってしまう)。
    near_ref = set()
    for r in tdf.texts:
        text = tdf.resolve_text(r)
        if (text and _looks_like_size(text) and _has_dims(text) and x_lo <= r.x <= x_hi
                and abs(r.y - (_ly + _ry) / 2.0) <= _SIZE_JOINT_Y_BAND):
            near_ref.add(text)
    if len(near_ref) == 1:
        return next(iter(near_ref))

    def _is_joint_size(pos) -> bool:
        return not (x_lo <= pos[0] <= x_hi)

    # 上の2つで決まらないとき: 継手と同じ高さ(上下400以内)・長さのX範囲の中に、サイズの文字がちょうど
    # 1種類だけあれば、それが梁本体のサイズ(2026-11-13、26-17 B2M4B-09 の B2M4HB100z-3。短い梁で、
    # 継手にいちばん近いサイズの文字が梁自身の上の文字になり、隣の部材のサイズとみなされず空になっていた)
    def _near_joints_in_range():
        ys = [j["cy"] for j in (left_jobj, right_jobj) if j]
        if not ys:
            return None
        found = set()
        for r in tdf.texts:
            text = tdf.resolve_text(r)
            if (text and _looks_like_size(text) and _has_dims(text) and x_lo <= r.x <= x_hi
                    and any(abs(r.y - y) <= _SIZE_NEAR_JOINT_Y_BAND for y in ys)):
                found.add(text)
        return next(iter(found)) if len(found) == 1 else None

    size_l = _nearest_size_text_no_size(tdf, left_jobj["cx"], left_jobj["cy"]) if left_jobj else None
    size_r = _nearest_size_text_no_size(tdf, right_jobj["cx"], right_jobj["cy"]) if right_jobj else None
    refs = [p for p in (size_l, size_r) if p is not None and _is_joint_size(p)]
    if not refs:
        return _near_joints_in_range()

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
    return _near_joints_in_range()


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
# 2026-09-16、S-1 R1G-13対応で2→4に引き上げ: 呼び出し側(extract_to_excel.py)
# の「一致直線数(a)が僅差の場合のみ試す」という事前ゲートを撤廃したため、
# 誤って高い一致直線数を持つ候補(`N-1 2G-05`の正解10480.0は一致直線数5本、
# 誤答12900.0の系統数はたった3)を巻き込まないよう、この採用基準自体を
# 引き上げて安全弁とした。
_CHAIN_MIN_WIN_COUNT = 4     # この系統数以上、かつ他候補より厳密に多い場合のみ採用


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
