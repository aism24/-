"""実寸法師(.tdf)バイナリの低レベルパーサー。

tdfファイルはオフセットベースの可変長レコード形式。本モジュールは以下の4種類の
要素を読み取り専用で解析する(書き込みは一切行わない)。

1. テキスト要素: マーカー「00 N (2*N) 00」(Nはテキストの機能種別、1〜63)で検出。
   ヘッダー52バイト([pre_field:4][X,Y,H,W,rot:各8]*5[pad:4][id_field:4])の後に
   マーカー(4)+val1,val2(4*2)+文字列(cp932)が続く。
   同じ文字列が図面内に複数回現れることがあり、実体をもつ「本体」と、本体の
   id_fieldを指すだけで自分では文字列を持たない「参照」に分かれる。

2. 直線要素: サイズヘッダー0x80000038(56バイト)、val=1、その後
   [ref:4]*3 + [x1,y1,x2,y2: double]*4。

3. 円弧要素: 「中心+半径」レコード(サイズ0x80000030=48バイト、val=2、
   [ref:4]*4 + [cx,cy,r: double]*3)の直後に、「開始角・終了角」レコード
   (サイズ0x80000020=32バイト、[cx?][val][ref] + [a1,a2: double(rad)]*2、
   実際の角度値はレコード先頭+16バイト目から)が続く。

4. 折れ線要素(2026-11-06 追加): サイズヘッダー 0x80000000 | (28 + 16*点数)、val=16、
   [ref:4]*3 + 点数:4 + [x,y: double]*点数。四角のベースプレート等が1つの折れ線で
   描かれる(26-12 の 1P-17)。直線の一覧には加えず、TdfData.polylines に別に持つ。

これらの構造は2026-09realistic実機データの解析で判明したもので、正式仕様書は無い。
"""
from __future__ import annotations

import math
import re
import struct
import unicodedata
from dataclasses import dataclass, field

HEADER_LEN = 52
MAX_N = 63

_SIZE_LINE = -2147483592       # 0x80000038 = 56
_SIZE_ARC_CENTER = -2147483600  # 0x80000030 = 48
_SIZE_ARC_ANGLE = -2147483616   # 0x80000020 = 32
_PAT_LINE = struct.pack("<i", _SIZE_LINE)
_PAT_ARC_CENTER = struct.pack("<i", _SIZE_ARC_CENTER)
_PAT_VAL16 = struct.pack("<i", 16)

DAI_PATTERN = re.compile(r"^[0-9]+台$")

# 直線・円弧の座標として読む値の上限(壊れた値を除くため)。当初1,000,000だったが、
# N2B-40〜42等(26-14 N棟の小梁、23ファイル)はx=1,000,000を超える位置に描かれており、
# 線と長丸がほぼすべて捨てられていた(2026-10-29)。上げても1,000,000以下の図面の
# 読み取り結果は変わらないことを確認済み。
_COORD_LIMIT = 10_000_000


@dataclass
class TextRecord:
    idx: int
    rec_start: int
    x: float
    y: float
    h: float
    w: float
    rot: float
    id_field: int
    text: str | None


@dataclass
class LineRecord:
    offset: int
    ref0: int
    x1: float
    y1: float
    x2: float
    y2: float

    @property
    def length(self) -> float:
        return math.hypot(self.x2 - self.x1, self.y2 - self.y1)


@dataclass
class ArcRecord:
    offset: int
    cx: float
    cy: float
    r: float
    a1: float | None  # 開始角(ラジアン)


@dataclass
class TdfData:
    path: str
    raw: bytes
    texts: list[TextRecord] = field(default_factory=list)
    lines: list[LineRecord] = field(default_factory=list)
    arcs: list[ArcRecord] = field(default_factory=list)
    polylines: list = field(default_factory=list)  # [(offset, [(x, y), ...]), ...]
    body_text_by_id: dict[int, str] = field(default_factory=dict)
    body_rot_by_id: dict[int, float] = field(default_factory=dict)

    def resolve_text(self, rec: TextRecord) -> str | None:
        if rec.text is not None:
            return rec.text
        return self.body_text_by_id.get(rec.id_field)

    def resolve_rot(self, rec: TextRecord) -> float:
        if rec.text is not None:
            return rec.rot
        return self.body_rot_by_id.get(rec.id_field, 0.0)


def _occurrences(data: bytes, pat: bytes, end: int):
    """data の中で pat が始まる位置(end 未満)を、重なりも含めて前から順に返す。
    1バイトずつ Python で比べる代わりに bytes.find で探す(2026-11-09。結果は同じ)。"""
    i = data.find(pat)
    while i != -1 and i < end:
        yield i
        i = data.find(pat, i + 1)


def _find_all_text_markers(data: bytes) -> list[int]:
    """「00 N (2*N) 00」(N は 1〜MAX_N)の位置を小さい順に返す。"""
    idxs = []
    end = len(data) - 3
    for b1 in range(1, MAX_N + 1):
        idxs.extend(_occurrences(data, bytes((0, b1, b1 * 2, 0)), end))
    idxs.sort()
    return idxs


def _parse_texts(data: bytes) -> list[TextRecord]:
    records = []
    for idx in _find_all_text_markers(data):
        rec_start = idx - HEADER_LEN
        if rec_start < 0:
            continue
        try:
            x, y, h, w, rot = struct.unpack_from("<5d", data, rec_start + 4)
            id_field = struct.unpack_from("<I", data, rec_start + 48)[0]
            val1, _val2 = struct.unpack_from("<2i", data, idx + 4)
        except struct.error:
            continue

        text = None
        text_len = val1 - 8
        text_start = idx + 12
        if 0 < text_len <= 200 and text_start + text_len <= len(data):
            raw = data[text_start:text_start + text_len]
            nul = raw.find(b"\x00")
            if nul != -1:
                raw = raw[:nul]
            if raw:
                try:
                    text = raw.decode("cp932")
                except UnicodeDecodeError:
                    text = None

        records.append(TextRecord(idx, rec_start, x, y, h, w, rot, id_field, text))
    return records


def _parse_lines(data: bytes) -> list[LineRecord]:
    lines = []
    for i in _occurrences(data, _PAT_LINE, len(data) - 56):
        val = struct.unpack_from("<i", data, i + 4)[0]
        if val == 1:
            try:
                ref0 = struct.unpack_from("<i", data, i + 8)[0]
                x1, y1, x2, y2 = struct.unpack_from("<4d", data, i + 24)
            except struct.error:
                continue
            if all(v == v and abs(v) < _COORD_LIMIT for v in (x1, y1, x2, y2)):
                lines.append(LineRecord(i, ref0, x1, y1, x2, y2))
    return lines


def _parse_arcs(data: bytes) -> list[ArcRecord]:
    n = len(data)
    arcs = []
    for i in _occurrences(data, _PAT_ARC_CENTER, n - 48):
        val = struct.unpack_from("<i", data, i + 4)[0]
        if val == 2:
            try:
                cx, cy, r = struct.unpack_from("<3d", data, i + 24)
            except struct.error:
                continue
            if cx == cx and cy == cy and r == r and 0 < r < 1000 and abs(cx) < _COORD_LIMIT and abs(cy) < _COORD_LIMIT:
                a1 = None
                angle_off = i + 48
                if angle_off + 32 <= n:
                    size2 = struct.unpack_from("<i", data, angle_off)[0]
                    if size2 == _SIZE_ARC_ANGLE:
                        try:
                            a1, _a2 = struct.unpack_from("<2d", data, angle_off + 16)
                        except struct.error:
                            a1 = None
                arcs.append(ArcRecord(i, cx, cy, r, a1))
    return arcs


def _parse_polylines(data: bytes) -> list:
    """折れ線要素(モジュールの説明の4)。戻り値: [(オフセット, [(x, y), ...]), ...]"""
    n = len(data)
    out = []
    nxt = 0  # 読み取った折れ線の中は探さない(以前の i += size と同じ)
    # 4バイト目からの「16」(val)を探し、その4バイト前をレコードの先頭とする
    for j in _occurrences(data, _PAT_VAL16, n - 24):
        i = j - 4
        if i < nxt:
            continue
        size_raw = struct.unpack_from("<i", data, i)[0]
        if size_raw < 0 and (size_raw & 0x7FFFFFFF) >= 60:
            size = size_raw & 0x7FFFFFFF
            cnt = struct.unpack_from("<i", data, i + 24)[0]
            if 2 <= cnt <= 1000 and size == 28 + 16 * cnt and i + 28 + 16 * cnt <= n:
                pts = [struct.unpack_from("<2d", data, i + 28 + 16 * k) for k in range(cnt)]
                if all(v == v and abs(v) < _COORD_LIMIT for pt in pts for v in pt):
                    out.append((i, pts))
                    nxt = i + size
    return out


def load(path: str) -> TdfData:
    """tdfファイルを読み取り専用で解析する。"""
    with open(path, "rb") as f:
        raw = f.read()

    texts = _parse_texts(raw)
    lines = _parse_lines(raw)
    arcs = _parse_arcs(raw)
    polylines = _parse_polylines(raw)

    body_text_by_id: dict[int, str] = {}
    body_rot_by_id: dict[int, float] = {}
    for r in texts:
        if r.text is not None:
            body_text_by_id.setdefault(r.id_field, r.text)
            body_rot_by_id.setdefault(r.id_field, r.rot)

    return TdfData(
        path=path, raw=raw, texts=texts, lines=lines, arcs=arcs, polylines=polylines,
        body_text_by_id=body_text_by_id, body_rot_by_id=body_rot_by_id,
    )


def is_dai_cell(text: str | None) -> bool:
    """「N台」形式のセルかどうか(全角/半角ゆれを吸収)。"""
    if not text:
        return False
    normalized = unicodedata.normalize("NFKC", text)
    return bool(DAI_PATTERN.match(normalized))
