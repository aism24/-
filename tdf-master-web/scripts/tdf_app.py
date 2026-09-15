"""ブラウザ(Pyodide)から呼び出すTDF抽出アプリのラッパー。

tdf_binary.py / tdf_master_extractor.py / tdf_master_extractor_multi.py は
一切変更せず、そのままインポートして使う。このファイルはExcel(openpyxl)への
書き込みを行っていた extract_to_excel.py / extract_to_excel_small_beam.py の
「1ファイル分の抽出ロジック」を、dictのリストとして返す形に置き換えただけの
薄いラッパーであり、判定ロジック自体は一切変更していない。

大梁(extract_to_excel.py)・小梁(extract_to_excel_small_beam.py)で
sort_rows / compute_tier_info の実装が微妙に異なる(小梁側にのみ
「直上の段で同じ列の行だけを対象にy_maxを計算する」補正が入っている)ため、
それぞれ元のスクリプトの実装をそのまま個別関数として維持している。
"""
from __future__ import annotations

import math

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
# 大梁(1G系) — extract_to_excel.py の1ファイル分の処理をそのまま移植
# ---------------------------------------------------------------------------

def _sort_rows_large(rows: list) -> None:
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


def _compute_tier_info_large(rows: list) -> dict:
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
        y_max = None if i == 0 else min(r.y for r in tiers[i - 1])
        for r in tier:
            info[id(r)] = (tier_label, y_max)
    return info


# 継手判定(大梁専用)。2026-09-14当初は「GJで始まるテキストのみ継手候補」
# だったが、WA2-3G-05でGJ以外の継手コード(GW100G)が見つかったため、小梁と
# 同じ「長丸で囲まれたテキストは全て継手マークの一種」という前提に切り替えた
# (masamizsumi-dotcom/tdf-master-extract の extract_to_excel.py と同一ロジック)。
# 大梁の図面では長丸が柱マーク(P441等)も囲むことがあるため、その柱マークが
# 近傍(1000mm以内)に円で囲まれていない形でも重複して描かれている場合は
# 除外する(_has_nearby_duplicate)。
NEARBY_DUP_RANGE = 1000.0


def _has_nearby_duplicate(tdf: tb.TdfData, mx: float, my: float, text: str) -> bool:
    for rec in tdf.texts:
        if abs(rec.x - mx) < 3 and abs(rec.y - my) < 3:
            continue  # 長丸内の自分自身は除く
        if abs(rec.x - mx) > NEARBY_DUP_RANGE or abs(rec.y - my) > NEARBY_DUP_RANGE:
            continue
        other = tdf.resolve_text(rec)
        if not other:
            continue
        if other.strip().isdigit():
            continue  # 寸法値等の純粋な数値は比較対象外
        if other == text or text in other or other in text:
            return True
    return False


def _assign_joints_batch_large(tdf: tb.TdfData, rows: list, tier_info: dict, lengths: dict) -> dict:
    raw_groups: dict[tuple, list] = {}
    for r in rows:
        key = (round(r.x_mark, 1), round(r.x_next, 1))
        raw_groups.setdefault(key, []).append(r)

    groups: dict[tuple, list] = {}
    for key, members in raw_groups.items():
        members_by_y = sorted(members, key=lambda r: r.y)
        clusters: list[list] = [[members_by_y[0]]]
        for r in members_by_y[1:]:
            if r.y - clusters[-1][-1].y > TIER_Y_GAP_THRESHOLD:
                clusters.append([r])
            else:
                clusters[-1].append(r)
        for i, cluster in enumerate(clusters):
            groups[(key, i)] = cluster

    centers = ex.find_stadium_centers(tdf)
    candidates_raw = []
    for mx, my, _r in centers:
        near = [rec for rec in tdf.texts if abs(rec.x - mx) < 3 and abs(rec.y - my) < 3]
        for rec in near:
            t = tdf.resolve_text(rec)
            if not t:
                continue
            if _has_nearby_duplicate(tdf, mx, my, t):
                continue
            candidates_raw.append((mx, my, t))

    claims: dict[tuple, tuple] = {}
    for key, members in groups.items():
        member_lengths = [lengths[id(r)] for r in members if lengths.get(id(r)) is not None]
        if not member_lengths:
            continue
        length_value = max(member_lengths)
        main_axis_deg = 0.0
        theta = -math.radians(main_axis_deg)

        def rotate(x, y, theta=theta):
            xr = x * math.cos(theta) - y * math.sin(theta)
            yr = x * math.sin(theta) + y * math.cos(theta)
            return xr, yr

        threshold = max(length_value * 0.6, exm.JOINT_MIN_THRESHOLD)
        for r in members:
            _tier_label, y_max = tier_info.get(id(r), (None, None))
            row_length = lengths.get(id(r))
            line_endpoints = None
            if row_length is not None:
                line_endpoints = exm._find_reference_line_endpoints(
                    tdf, r.x_mark, r.x_next, r.y, y_max, row_length,
                )
            if line_endpoints is not None:
                (lx, ly), (rx, ry) = line_endpoints
                left_ref, right_ref = (lx, ly), (rx, ry)
                use_2d = True
            else:
                x_mark_r, _ = rotate(r.x_mark, r.y)
                x_next_r, _ = rotate(r.x_next, r.y)
                left_ref, right_ref = (x_mark_r, None), (x_next_r, None)
                use_2d = False
            for mx, my, t in candidates_raw:
                if my <= r.y or (y_max is not None and my >= y_max):
                    continue
                xr, yr = rotate(mx, my)
                for side, ref in (("left", left_ref), ("right", right_ref)):
                    if use_2d:
                        dist = math.hypot(mx - ref[0], my - ref[1])
                    else:
                        dist = abs(xr - ref[0])
                    if dist > threshold:
                        continue
                    cand_key = (round(mx, 2), round(my, 2), t, side)
                    cur = claims.get(cand_key)
                    if cur is None or dist < cur[0]:
                        claims[cand_key] = (dist, key)

    best_per_group_side: dict[tuple, tuple] = {}
    for (_mx, _my, t, side), (dist, key) in claims.items():
        cur = best_per_group_side.get((key, side))
        if cur is None or dist < cur[0]:
            best_per_group_side[(key, side)] = (dist, t)

    group_result: dict[tuple, list] = {}
    for (key, side), (_dist, t) in best_per_group_side.items():
        left_right = group_result.setdefault(key, [None, None])
        left_right[0 if side == "left" else 1] = t

    row_result = {}
    for key, members in groups.items():
        left, right = group_result.get(key, (None, None))
        for r in members:
            row_result[id(r)] = (left, right)
    return row_result


def _extract_large_beam(tdf: tb.TdfData) -> list[dict]:
    drawing_number = ex.find_drawing_number(tdf)
    rows = ex.find_product_rows(tdf)
    existing_dai_positions = {(round(r.x_next, 1), round(r.y, 1)) for r in rows}
    rows = rows + exm.find_product_rows_shared_group(tdf, existing_positions=existing_dai_positions)
    _sort_rows_large(rows)
    tier_info = _compute_tier_info_large(rows)

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

    joints = _assign_joints_batch_large(tdf, rows, tier_info, lengths)

    out = []
    for row in rows:
        tier_label, _tier_y_max = tier_info.get(id(row), (None, None))
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
# 小梁(1B系) — extract_to_excel_small_beam.py の1ファイル分の処理をそのまま移植
# ---------------------------------------------------------------------------

def _get_rows_small(tdf: tb.TdfData) -> list:
    rows = ex.find_product_rows(tdf)
    existing = {(round(r.x_next, 1), round(r.y, 1)) for r in rows}
    rows = rows + exm.find_product_rows_shared_group(tdf, existing_positions=existing)
    rows = exm.filter_deleted_rows(tdf, rows)
    return rows


def _sort_rows_small(rows: list) -> None:
    _sort_rows_large(rows)  # ロジックは大梁側と同一


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

_last_extract_info: dict = {}


def extract_file(path: str, beam_type: str) -> list[dict]:
    """1つの.tdfファイルを解析して製品情報のリスト(dict)を返す。

    beam_type: "large"(大梁・1G系) または "small"(小梁・1B系)。
    """
    global _last_extract_info
    tdf = tb.load(path)
    if beam_type == "small":
        rows = _extract_small_beam(tdf)
    else:
        rows = _extract_large_beam(tdf)

    _last_extract_info = {
        "no_product_table_found": len(rows) == 0,
    }
    return rows
