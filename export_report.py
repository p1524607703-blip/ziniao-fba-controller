#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FBA 重测 — 提交情况对账表导出

从控制器 state.json 读取跑批结果，与源 Excel 的 FNSKU 清单逐条对账，
产出一份四页工作簿：汇总 / 已提交成功 / 未提交-待重排 / 异常明细。

设计要点（都是踩过的坑，别改掉）：
  1. 只统计"源表里存在的 SKU"——state.json 会残留上一批次的记录，不过滤就对不上账。
  2. 出表前先做对账自检：已提交 + 异常 + 待处理 必须等于源表总数，不等就直接报错退出，
     并打印"重复项 / 未进队列的 SKU"，避免交出一份数字自相矛盾的表。
  3. case ID 可能缺失（早期版本未采集），缺失时明确标注"已提交（编号未采集）"，
     不能留空让人以为没提交。

用法:
    python3 export_report.py \
        --state /path/to/fba-controller/state.json \
        --source ~/Desktop/报销单/2026年9月10日重测.xlsx \
        --out   ~/Desktop/报销单/FBA重测提交情况-2026-09-10.xlsx

依赖: openpyxl
"""

import argparse
import datetime
import json
import os
import re
import sys

try:
    import openpyxl
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter
except ImportError:
    sys.exit("缺少依赖 openpyxl，请先安装：pip install openpyxl")

# ---------------------------------------------------------------- 常量
MONTHLY_QUOTA = 120  # 亚马逊 FBA 重测每月额度上限

HDR_FILL = PatternFill('solid', fgColor='1F4E79')
HDR_FONT = Font(color='FFFFFF', bold=True, size=11)
OK_FILL = PatternFill('solid', fgColor='E2EFDA')
WARN_FILL = PatternFill('solid', fgColor='FFF2CC')
BAD_FILL = PatternFill('solid', fgColor='FCE4EC')
THIN = Side(style='thin', color='BFBFBF')
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)


# ---------------------------------------------------------------- 工具
def bj(ts):
    """毫秒时间戳 -> 北京时间字符串（空值返回 —，避免误显示 1970）"""
    if ts is None:
        return '—'
    return (datetime.datetime.fromtimestamp(ts / 1000, datetime.timezone.utc)
            + datetime.timedelta(hours=8)).strftime('%Y-%m-%d %H:%M:%S')


def read_source(path, column=None):
    """读取源表，返回 (FNSKU 清单, 款号映射)。

    两种常见形态都支持：
      * 单列清单（FNSKU 就在 A 列）——默认行为
      * 双列清单（A 列款号 + B 列 FNSKU，运营给的表常长这样）——自动识别，
        并顺带把款号带出来写进结果表（运营看款号比看 FNSKU 直观）。
    显式传 column 时以传入值为准。
    """
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb[wb.sheetnames[0]]
    cols = [c for c in ws.iter_cols(values_only=True) if any(v is not None for v in c)]

    def looks_fns(x):
        return bool(re.fullmatch(r'X[A-Z0-9]{9}', str(x).strip(), re.I))

    if column:
        vals = [str(c.value).strip() for c in ws[column] if c.value]
        return [v for v in vals if v and v.lower() != 'fnsku'], {}

    best_col, best_hit = 0, -1
    for idx, col in enumerate(cols):
        cells = [str(v).strip() for v in col if v is not None]
        if not cells:
            continue
        hit = sum(1 for v in cells if looks_fns(v))
        if hit > best_hit:
            best_col, best_hit = idx, hit

    fn_col = [str(v).strip() for v in cols[best_col] if v is not None]
    if best_hit > 0:
        print(f'自动识别 FNSKU 所在列：第 {best_col + 1} 列（命中 {best_hit} 条）')

    # 找款号列：优先双列表里 FNSKU 左边那一列
    style_map = {}
    if best_hit > 0 and best_col > 0:
        other = cols[best_col - 1]
        for i, fn in enumerate(fn_col):
            if looks_fns(fn) and i < len(other) and other[i] is not None:
                style_map.setdefault(fn, str(other[i]).strip())
        if style_map:
            print(f'已带出款号列：第 {best_col} 列（{len(style_map)} 条）')

    return [v for v in fn_col if v and v.lower() != 'fnsku'], style_map


def style_header(ws, row=1):
    for c in ws[row]:
        if c.value is not None:
            c.fill, c.font = HDR_FILL, HDR_FONT
            c.alignment = Alignment(horizontal='center', vertical='center')
    ws.freeze_panes = ws.cell(row=row + 1, column=1)


def autosize(ws, widths):
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w


def classify(reason):
    """把失败原因归类成人看得懂的异常类型"""
    r = reason or ''
    if '不符合重新测量' in r or '无重测资格' in r:
        return '额度用尽 / 不符合重测资格'
    if '无可测量库存' in r:
        return '无可测量库存（待补货）'
    if '结构' in r:
        return '页面结构未识别（疑似同类额度问题）'
    return '其他'


def advice_of(kind):
    if '额度' in kind:
        return '下月额度恢复后重试'
    if '库存' in kind:
        return '补货后再试'
    return '下月额度恢复后重试'


# ---------------------------------------------------------------- 主流程
def main():
    ap = argparse.ArgumentParser(description='导出 FBA 重测提交情况对账表')
    ap.add_argument('--state', required=True, help='控制器 state.json 路径')
    ap.add_argument('--source', required=True, help='源 FNSKU 清单 xlsx 路径')
    ap.add_argument('--out', required=True, help='输出 xlsx 路径')
    ap.add_argument('--since', default=None,
                    help='本轮起始日期 YYYY-MM-DD（北京时间）。传入后自动区分'
                         '「本轮新提交」与「历史已提交」，并标注历史行。')
    args = ap.parse_args()

    for p in (args.state, args.source):
        if not os.path.exists(p):
            sys.exit(f'文件不存在: {p}')

    s = json.load(open(args.state, encoding='utf-8'))
    src, style_map = read_source(args.source)
    src_set = set(src)

    done = [d for d in s.get('done', []) if d['sku'] in src_set]
    failed = [f for f in s.get('failed', []) if f['sku'] in src_set]
    pending = [p['sku'] for p in s.get('pending', []) if p['sku'] in src_set]

    # ---- 对账自检：数字必须闭合 ----
    seen, dup = set(), set()
    for k in [d['sku'] for d in done] + [f['sku'] for f in failed] + pending:
        (dup if k in seen else seen).add(k)
    missing = [x for x in src if x not in seen]

    print(f'源表 {len(src)} 条 | 已提交 {len(done)} | 异常 {len(failed)} | 待处理 {len(pending)}')
    if dup:
        print(f'⚠️ 重复计入的 SKU（同时出现在多个状态里）: {sorted(dup)}')
    if missing:
        print(f'⚠️ 源表中从未进队列的 SKU: {missing}')
    total = len(done) + len(failed) + len(pending)
    if total != len(src):
        print(f'❌ 对账不闭合：{len(done)}+{len(failed)}+{len(pending)}={total} ≠ 源表 {len(src)}')
        print('   请先修正 state.json（去重 / 补回遗漏），再重新导出。')
        sys.exit(1)
    print('✅ 对账闭合')

    n_case = sum(1 for d in done if d.get('caseId'))

    # ---- 本轮 vs 历史切分（--since 给出北京时间日期，按天粒度比较）----
    since_ts = None
    if args.since:
        try:
            d0 = datetime.datetime.strptime(args.since.strip(), '%Y-%m-%d')
        except ValueError:
            sys.exit(f'--since 格式应为 YYYY-MM-DD，收到: {args.since}')
        since_ts = int((d0 - datetime.timedelta(hours=8)
                        - datetime.datetime(1970, 1, 1)).total_seconds() * 1000)
    cur = [d for d in done if since_ts is not None and d['ts'] >= since_ts]
    hist = [d for d in done if since_ts is not None and d['ts'] < since_ts]
    if hist:
        shown = '、'.join('{}({})'.format(d['sku'], bj(d['ts'])[:10]) for d in hist[:5])
        if len(hist) > 5:
            shown += ' 等 {} 条'.format(len(hist))
        hist_note = shown + ' 于本轮之前提交，本轮未重复消耗额度'
    else:
        hist_note = '无'

    wb = openpyxl.Workbook()

    # ---------- 汇总 ----------
    ws = wb.active
    ws.title = '汇总'
    ts_pool = [d['ts'] for d in done] + [f['ts'] for f in failed]
    last_ts = max(ts_pool) if ts_pool else None
    if pending and not failed:
        stop_reason = '月度额度用尽（推定）'
        stop_note = (f'亚马逊 FBA 重测每月上限约 {MONTHLY_QUOTA} 条；额度用尽后返回'
                     '「不符合重新测量资格」终态页（页面无任何按钮）')
    elif not pending and not failed:
        stop_reason = '本次已全部处理完毕'
        stop_note = '无遗留、无异常'
    else:
        stop_reason = '存在异常项'
        stop_note = '详见「异常明细」页'
    rows = [
        ('项目', '数量', '说明'),
        ('📋 本批 FNSKU 总数', len(src), f'源表：{os.path.basename(args.source)}'),
        ('✅ 已提交成功', len(done), f'其中 {n_case} 条已取到亚马逊问题编号(case ID)'),
        ('⏳ 未提交（待重排）', len(pending),
         '额度恢复后可继续' if pending else '无（本次全部处理完毕）'),
        ('❌ 异常/被拒', len(failed), '见「异常明细」页'),
        ('', '', ''),
        ('停止原因', stop_reason, stop_note),
        ('本月累计提交', len(done), f'相对每月 {MONTHLY_QUOTA} 条额度（跨批次累计，仅供参考）'),
        ('', '', ''),
        ('最后提交时间(北京)', bj(last_ts), '控制器已暂停，未继续消耗额度'),
    ]
    if since_ts is not None:
        rows += [
            ('', '', ''),
            ('🚀 本轮新提交', len(cur), f'按 --since {args.since} 判定，均取得亚马逊问题编号，可逐条核对'),
            ('📦 其中历史已提交', len(hist), hist_note if hist else '无'),
        ]
    for r in rows:
        ws.append(list(r))
    style_header(ws)
    for row in ws.iter_rows(min_row=2):
        for c in row:
            c.border = BORDER
    ws['A7'].font = Font(bold=True, color='C00000')
    ws['B7'].font = Font(bold=True, color='C00000')
    autosize(ws, [22, 18, 74])

    # ---------- 已提交成功 ----------
    ws = wb.create_sheet('已提交成功')
    has_style = bool(style_map)
    hdr = ['#', 'FNSKU'] + (['款号'] if has_style else []) + ['提交时间(北京)', '问题编号(case ID)', '结果']
    ws.append(hdr)
    for i, d in enumerate(sorted(done, key=lambda x: x['ts']), 1):
        is_hist = since_ts is not None and d['ts'] < since_ts
        note = d.get('note') or '已创建问题'
        cid = d.get('caseId') or '已提交（编号未采集）'
        if is_hist:
            cid = d.get('caseId') or '—'
            note = f'{bj(d["ts"])[:10]} 已提交（本轮之前，未重复提交）'
        row = [i, d['sku']] + ([style_map.get(d['sku'], '')] if has_style else []) + [
            bj(d['ts']), cid, note]
        ws.append(row)
    style_header(ws)
    for row in ws.iter_rows(min_row=2):
        for c in row:
            c.border = BORDER
        cid = row[3 + (1 if has_style else 0)]
        if cid.value and str(cid.value).isdigit():
            cid.fill = OK_FILL
    autosize(ws, [6, 16, 22, 22, 24, 18] if has_style else [6, 16, 22, 24, 18])

    # ---------- 未提交待重排 ----------
    ws = wb.create_sheet('未提交-待重排')
    ws.append(['#', 'FNSKU'] + (['款号'] if style_map else []) + ['状态', '建议'])
    for i, k in enumerate(pending, 1):
        ws.append([i, k] + ([style_map.get(k, '')] if style_map else []) + ['未提交', '下月额度恢复后继续'])
    if not pending:
        # 占位行的列数必须与表头一致（带款号列时多一格）
        ws.append(['—', '无'] + ([''] if style_map else []) + ['—', '本次无剩余未提交项'])
    style_header(ws)
    col_status = 3 if style_map else 2   # 「状态」列位置随款号列偏移
    for row in ws.iter_rows(min_row=2):
        for c in row:
            c.border = BORDER
        if row[col_status].value != '—':
            row[col_status].fill = WARN_FILL
    autosize(ws, [6, 16, 22, 12, 30] if style_map else [6, 16, 12, 30])

    # ---------- 异常明细 ----------
    ws = wb.create_sheet('异常明细')
    ws.append(['#', 'FNSKU'] + (['款号'] if style_map else []) + ['异常类型', '页面展示包裹尺寸', '页面展示包裹重量', '时间(北京)', '建议'])
    for i, f in enumerate(sorted(failed, key=lambda x: x['ts']), 1):
        d = f.get('dims') or {}
        kind = classify(f.get('reason'))
        ws.append([i, f['sku']] + ([style_map.get(f['sku'], '')] if style_map else []) + [kind,
                   d.get('size') or '—', d.get('weight') or '—',
                   bj(f['ts']), advice_of(kind)])
    if not failed:
        ws.append(['—', '无'] + ([''] if style_map else []) + ['—', '—', '—', '—', '本次无异常项'])
    style_header(ws)
    col_kind = 3 if style_map else 2     # 「异常类型」列位置随款号列偏移
    for row in ws.iter_rows(min_row=2):
        for c in row:
            c.border = BORDER
        if row[col_kind].value != '—':
            row[col_kind].fill = BAD_FILL
    autosize(ws, [6, 16, 22, 30, 26, 20, 22, 28] if style_map else [6, 16, 30, 26, 20, 22, 28])

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    wb.save(args.out)
    print(f'✅ 已导出: {args.out}')


if __name__ == '__main__':
    main()
