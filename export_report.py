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
    """毫秒时间戳 -> 北京时间字符串"""
    return (datetime.datetime.fromtimestamp(ts / 1000, datetime.timezone.utc)
            + datetime.timedelta(hours=8)).strftime('%Y-%m-%d %H:%M:%S')


def read_source(path, column='A'):
    """读取源表 FNSKU 清单（自动跳过表头）"""
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb[wb.sheetnames[0]]
    vals = [str(c.value).strip() for c in ws[column] if c.value]
    return [v for v in vals if v.lower() != 'fnsku']


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
    args = ap.parse_args()

    for p in (args.state, args.source):
        if not os.path.exists(p):
            sys.exit(f'文件不存在: {p}')

    s = json.load(open(args.state, encoding='utf-8'))
    src = read_source(args.source)
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
    wb = openpyxl.Workbook()

    # ---------- 汇总 ----------
    ws = wb.active
    ws.title = '汇总'
    last_ts = max([d['ts'] for d in done] + [f['ts'] for f in failed])
    rows = [
        ('项目', '数量', '说明'),
        ('📋 本批 FNSKU 总数', len(src), f'源表：{os.path.basename(args.source)}'),
        ('✅ 已提交成功', len(done), f'其中 {n_case} 条已取到亚马逊问题编号(case ID)'),
        ('⏳ 未提交（待重排）', len(pending), '本月额度已用尽，下月恢复后继续'),
        ('❌ 异常/被拒', len(failed), '见「异常明细」页'),
        ('', '', ''),
        ('🔴 停止原因', '月度额度用尽',
         f'亚马逊 FBA 重测每月上限 {MONTHLY_QUOTA} 条；额度用尽后返回「不符合重新测量资格」终态页（无按钮）'),
        ('本月已用额度', len(done), f'{len(done)} / {MONTHLY_QUOTA}'),
        ('本月剩余额度', max(0, MONTHLY_QUOTA - len(done)), '下月自动恢复'),
        ('', '', ''),
        ('最后提交时间(北京)', bj(last_ts), '控制器已暂停，未继续消耗额度'),
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
    ws.append(['#', 'FNSKU', '提交时间(北京)', '问题编号(case ID)', '结果'])
    for i, d in enumerate(sorted(done, key=lambda x: x['ts']), 1):
        ws.append([i, d['sku'], bj(d['ts']),
                   d.get('caseId') or '已提交（编号未采集）',
                   d.get('note') or '已创建问题'])
    style_header(ws)
    for row in ws.iter_rows(min_row=2):
        for c in row:
            c.border = BORDER
        if row[3].value and str(row[3].value).isdigit():
            row[3].fill = OK_FILL
    autosize(ws, [6, 16, 22, 24, 18])

    # ---------- 未提交待重排 ----------
    ws = wb.create_sheet('未提交-待重排')
    ws.append(['#', 'FNSKU', '状态', '建议'])
    for i, k in enumerate(pending, 1):
        ws.append([i, k, '未提交', '下月额度恢复后继续'])
    style_header(ws)
    for row in ws.iter_rows(min_row=2):
        for c in row:
            c.border = BORDER
        row[2].fill = WARN_FILL
    autosize(ws, [6, 16, 12, 30])

    # ---------- 异常明细 ----------
    ws = wb.create_sheet('异常明细')
    ws.append(['#', 'FNSKU', '异常类型', '页面展示包裹尺寸', '页面展示包裹重量', '时间(北京)', '建议'])
    for i, f in enumerate(sorted(failed, key=lambda x: x['ts']), 1):
        d = f.get('dims') or {}
        kind = classify(f.get('reason'))
        ws.append([i, f['sku'], kind,
                   d.get('size') or '—', d.get('weight') or '—',
                   bj(f['ts']), advice_of(kind)])
    style_header(ws)
    for row in ws.iter_rows(min_row=2):
        for c in row:
            c.border = BORDER
        row[2].fill = BAD_FILL
    autosize(ws, [6, 16, 30, 26, 20, 22, 28])

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    wb.save(args.out)
    print(f'✅ 已导出: {args.out}')


if __name__ == '__main__':
    main()
