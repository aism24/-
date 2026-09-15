"""ブラウザ(Pyodide)から呼び出すTDF抽出アプリのラッパー。

tdf_binary.py / tdf_master_extractor.py / tdf_master_extractor_multi.py は
一切変更せず、そのままインポートして使う。このファイルはExcel(openpyxl)への
書き込みを行っていた extract_to_excel_small_beam.py の「1ファイル分の抽出
ロジック」を、dictのリストとして返す形に置き換えただけの薄いラッパーであり、
判定ロジック自体は一切変更していない。

当初は大梁(1G系)・小梁(1B系)を別ロジックとして実装していたが、小梁側の
ロジックですべてのファイルが正しく抽出できることを確認できたため、大梁専用
コードは削除し、この1系統のみで運用している。
"""
from __future__ import annotations

import tdf_binary as tb
import tdf_master_extractor as ex
import tdf_master_extractor_multi as exm

HEADERS = [
    "ID", "図番", "製品マーク", "設計符号", "サイズ", "本数",
    "長さ(m)", "重量", "左継手", "右継手", "種別", "製品段",
]

_AXIS_TOLERANCE_DEG = 2.0
TIER_Y_GAP_THRESHOLD = 3000.0


def classify_beam_type(main_axis_deg: float | None) -> str | None:
    if main_axis_deg is None:
        return None
    remainder = abs(main_axis_deg) % 90.0
    if remainder <= _AXIS_TOLERANCE_DEG or remainder >= 90.0 - _AXIS_TOLERANCE_DEG:
        return "普通梁"
    return "斜め梁"


# ---------------------------------------------------------------------------
# TDFファイル1件分の抽出ロジック — extract_to_excel_small_beam.py の
# 1ファイル分の処理をそのまま移植
# ---------------------------------------------------------------------------

def _get_rows_small(tdf: tb.TdfData) -> list:
    rows = ex.find_product_rows(tdf)
    existing = {(round(r.x_next, 1), round(r.y, 1)) for r in rows}
    rows = rows + exm.find_product_rows_shared_group(tdf, existing_positions=existing)
    rows = exm.filter_deleted_rows(tdf, rows)
    return rows


def _sort_rows_small(rows: list) -> None:
    prefix_max_y: dict[str, float] = {}
    prefix_min_x: dict[str, float] = {}
    for r in rows:
        p = exm.mark_prefix(r.mark)
        prefix_max_y[p] = max(prefix_max_y.get(p, r.y), r.y)
        prefix_min_x[p] = min(prefix_min_x.get(p, r.x_mark), r.x_mark)

    def key_func(r):
        p = exm.mark_prefix(r.mark)
        return (-prefix_max_y[p], prefix_min_x[p], exm.mark_sort_key(r.mark))

    rows.sort(key=key_func)


def _compute_tier_info_small(rows: list) -> dict:
    if not rows:
        return {}
    sorted_rows = sorted(rows, key=lambda r: -r.y)
    tiers = [[sorted_rows[0]]]
    for r in sorted_rows[1:]:
        if tiers[-1][-1].y - r.y > TIER_Y_GAP_THRESHOLD:
            tiers.append([r])
        else:
            tiers[-1].append(r)

    info = {}
    for i, tier in enumerate(tiers):
        tier_label = f"{i + 1}段"
        if i == 0:
            for r in tier:
                info[id(r)] = (tier_label, None)
            continue
        prev_tier = tiers[i - 1]
        global_y_max = min(r.y for r in prev_tier)
        for r in tier:
            same_col = [
                pr for pr in prev_tier
                if max(r.x_mark, pr.x_mark) < min(r.x_next, pr.x_next)
            ]
            y_max = min(pr.y for pr in same_col) if same_col else global_y_max
            info[id(r)] = (tier_label, y_max)
    return info


def _extract_small_beam(tdf: tb.TdfData) -> list[dict]:
    drawing_number = ex.find_drawing_number(tdf)
    rows = _get_rows_small(tdf)
    if not rows:
        return []

    _sort_rows_small(rows)
    tier_info = _compute_tier_info_small(rows)

    lengths: dict[int, float | None] = {}
    beam_types: dict[int, str | None] = {}
    for row in rows:
        _tier_label, tier_y_max = tier_info.get(id(row), (None, None))
        if len(rows) == 1:
            x_min = row.x_mark - ex.RELAX_MARGIN
            x_max = row.x_next + ex.RELAX_MARGIN
        else:
            x_min = row.x_mark
            x_max = row.x_next
        length_value, debug = ex.determine_length(tdf, x_min, x_max, row.y, y_max=tier_y_max)
        lengths[id(row)] = length_value
        beam_types[id(row)] = classify_beam_type(
            debug.get("main_axis_deg") if length_value is not None else None
        )

    joints = exm.assign_joints_batch(tdf, rows, tier_info, lengths)

    out = []
    for row in rows:
        tier_label, _y_max = tier_info.get(id(row), (None, None))
        length_value = lengths[id(row)]
        left, right = joints.get(id(row), (None, None))
        if length_value is None:
            left = right = None
        # 記録はm単位(内部の判定ロジックはmm前提のまま、出力直前だけ変換)。
        # masamizsumi-dotcom/tdf-master-extract の同種の変更に合わせたもの。
        length_value_m = None if length_value is None else length_value / 1000.0
        out.append({
            "図番": drawing_number, "製品マーク": row.mark, "設計符号": row.design_code,
            "サイズ": row.size, "本数": row.count, "長さ": length_value_m, "重量": row.weight,
            "左継手": left, "右継手": right, "種別": beam_types[id(row)], "製品段": tier_label,
        })
    return out


# ---------------------------------------------------------------------------
# JS側から呼び出すエントリポイント
# ---------------------------------------------------------------------------

def extract_file(path: str) -> list[dict]:
    """1つの.tdfファイルを解析して製品情報のリスト(dict)を返す。"""
    tdf = tb.load(path)
    return _extract_small_beam(tdf)
