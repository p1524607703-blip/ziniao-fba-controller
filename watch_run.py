#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FBA 重测跑批看门狗 (watch_run.py)

给 ziniao-fba-controller 的跑批加一层外部保护。控制台自身只对「基础设施类」
失败（结构不符/网络/targetId）做连续熔断，而**月度额度用尽**返回的
「不符合重新测量资格」被归类为业务失败，不会触发熔断 —— 结果是额度真用尽时
它会一条条把整批跑成失败再收工，白白耗费时间。

本脚本补上这个缺口：

  1. 额度守卫：连续 N 条「不符合重新测量资格」即自动暂停（默认 3 条）。
  2. 基础设施守卫：连续 M 条同因基础设施失败即暂停（默认 5 条，兜底）。
  3. 停滞守卫：超过 T 分钟状态毫无变化则告警（默认 15 分钟，只告警不暂停）。
  4. 进度输出：每轮打印进度，退出时打印本批小结。

⚠️ 必须用「基线法」判断连续失败：
   state.json 里混着**往批**的 failed 记录，直接看 failed 数组末尾元素会把
   上批的失败误当成本批的连续失败，从而在健康批次上误触发暂停（2026-09-14 踩过）。
   本脚本启动时记录 base_fail / base_done，之后只看基线之后的新增部分。

用法：
  python3 watch_run.py                        # 默认盯 127.0.0.1:8787
  python3 watch_run.py --interval 45 --max-not-eligible 3
  python3 watch_run.py --base-url http://127.0.0.1:8787 --out /tmp/watch.log
"""

import argparse
import datetime
import json
import sys
import time
import urllib.error
import urllib.request

NOT_ELIGIBLE_MARK = '不符合重新测量资格'
INFRA_MARKS = ('结构', '网络', 'targetId', 'exec', '步数超限', '连续')


def bj(ts=None):
    if ts is None:
        ts = time.time() * 1000
    return (datetime.datetime.fromtimestamp(ts / 1000, datetime.timezone.utc)
            + datetime.timedelta(hours=8)).strftime('%m-%d %H:%M:%S')


def fetch(base):
    with urllib.request.urlopen(base + '/api/state', timeout=10) as r:
        return json.loads(r.read().decode('utf-8'))


def post(base, path, payload=None):
    data = json.dumps(payload or {}).encode('utf-8')
    req = urllib.request.Request(base + path, data=data,
                                 headers={'Content-Type': 'application/json'},
                                 method='POST')
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read().decode('utf-8'))
    except Exception as e:
        return {'ok': False, 'msg': str(e)}


def classify(reason):
    r = str(reason or '')
    if NOT_ELIGIBLE_MARK in r:
        return 'NOT_ELIGIBLE'
    if any(m in r for m in INFRA_MARKS):
        return 'INFRA'
    return 'OTHER'


def bridge_health(url):
    """探测紫鸟 Bridge 健康度。返回 (ok, 耗时秒, 摘要)。

    Bridge 在负载下会「端口仍在监听但服务假死」——表现为 CLI 报
    『无法连接紫鸟浏览器 Bridge』。这是跑批变慢（步数超限）的先兆，
    单看控制器状态看不出来，必须直接探它。
    """
    t0 = time.time()
    try:
        with urllib.request.urlopen(url, timeout=8) as r:
            d = json.loads(r.read().decode('utf-8'))
        used = time.time() - t0
        st = d.get('status') or {}
        summary = 'loggedIn={} runningStores={}'.format(
            d.get('loggedIn'), st.get('runningStores'))
        return bool(d.get('ok')), used, summary
    except Exception as e:
        return False, time.time() - t0, str(e)[:60]


def main():
    ap = argparse.ArgumentParser(description='FBA 重测跑批看门狗')
    ap.add_argument('--base-url', default='http://127.0.0.1:8787')
    ap.add_argument('--interval', type=int, default=60, help='轮询间隔秒（默认 60）')
    ap.add_argument('--max-not-eligible', type=int, default=3,
                    help='连续多少条「不符合资格」即暂停（默认 3）')
    ap.add_argument('--max-infra', type=int, default=5,
                    help='连续多少条基础设施失败即暂停（默认 5）')
    ap.add_argument('--stall-minutes', type=int, default=15,
                    help='状态多少分钟无变化则告警（默认 15，只告警）')
    ap.add_argument('--bridge-url', default='http://127.0.0.1:9481/health',
                    help='紫鸟 Bridge 健康探测地址（传空串则跳过）')
    ap.add_argument('--out', default=None, help='日志文件（同时输出到 stdout）')
    args = ap.parse_args()

    base = args.base_url.rstrip('/')
    logf = open(args.out, 'a', encoding='utf-8') if args.out else None

    def say(msg):
        line = '[{}] {}'.format(bj(), msg)
        print(line, flush=True)
        if logf:
            logf.write(line + '\n')
            logf.flush()

    # ---- 建立基线（关键：只在基线上判断本批新增失败）----
    try:
        s0 = fetch(base)
    except Exception as e:
        sys.exit('✗ 无法连接控制器 {}: {}'.format(base, e))

    base_fail = len(s0.get('failed') or [])
    base_done = len(s0.get('done') or [])
    n_pending0 = len(s0.get('pending') or [])
    t_start = time.time()
    bridge_fail = 0
    say('🔍 看门狗启动 | 基线 failed={} done={} | 当前 pending={}'.format(
        base_fail, base_done, n_pending0))
    if n_pending0 == 0:
        say('ℹ️ 队列为空，无需盯守（确认你想跑的那批已入队？）')
        return

    last_sig, last_change = None, time.time()
    streak_ne, streak_infra = 0, 0
    last_fail_len = base_fail

    while True:
        time.sleep(args.interval)
        try:
            s = fetch(base)
        except Exception as e:
            say('⚠️ 取状态失败（服务可能已停）: {}'.format(e))
            continue

        pending = s.get('pending') or []
        done = s.get('done') or []
        failed = s.get('failed') or []
        if base_fail > len(failed):     # 基线被外部改动越过，跟着下移，否则永远看不到新增失败
            base_fail = len(failed)
        new_fails = failed[base_fail:]
        new_done = len(done) - base_done

        sig = (len(pending), len(done), len(failed))
        if sig != last_sig:
            last_sig, last_change = sig, time.time()

        # 列表被外部改动过（如人工把误伤的条目从 failed 捞回 pending、或重置了状态）：
        # failed 变短时旧下标会越界/漏检，必须把游标拉回来，否则新失败会被整段忽略。
        if last_fail_len > len(failed):
            say('ℹ️ 检测到 failed 列表被外部改动（{} → {}），重置失败游标'.format(
                last_fail_len, len(failed)))
            last_fail_len = len(failed)

        # 只看基线之后的新增失败，避免把上批失败当本批
        for f in failed[last_fail_len:]:
            k = classify(f.get('reason'))
            if k == 'NOT_ELIGIBLE':
                streak_ne += 1
                streak_infra = 0
            elif k == 'INFRA':
                streak_infra += 1
                streak_ne = 0
            else:
                streak_ne = streak_infra = 0
        last_fail_len = len(failed)

        say('📊 pending={} | 本批新增成功={} | 本批新增失败={} | 当前: {}'.format(
            len(pending), new_done, len(new_fails),
            s.get('inProgress') or ('运行中' if s.get('status') == 'running' else '已停')))

        # ---- 速率（本批平均每条耗时）----
        # 分母必须用「已处理总数 = 新增成功 + 新增失败」。
        # 只用成功数当分母时，失败/卡死耗掉的时间不会被摊掉 → 速率被虚增几倍、ETA 假性拖长。
        done_now = len(done)
        processed = new_done + len(new_fails)
        if processed > 0:
            spent = time.time() - t_start
            per = spent / processed
            remain = per * (len(pending) + (1 if s.get('inProgress') else 0))
            # ETA 必须跟日志时间戳同一时区（北京），否则同一行里出现两个时区，看着像差 12 小时
            eta = (datetime.datetime.now(datetime.timezone.utc)
                   + datetime.timedelta(hours=8, seconds=remain))
            say('⏱ 速率 {:.0f}s/条（均摊·含失败）| 预计剩余 {:.0f} 分钟 | 完成约 {}（北京）'.format(
                per, remain / 60, eta.strftime('%m-%d %H:%M')))

        # ---- 紫鸟 Bridge 健康度（跑批变慢/步数超限的先兆）----
        if args.bridge_url:
            b_ok, b_used, b_info = bridge_health(args.bridge_url)
            if b_ok and b_used > 3:
                say('⚠️ Bridge 响应偏慢：{:.1f}s（{}）'.format(b_used, b_info))
            elif not b_ok:
                bridge_fail += 1
                say('🔴 Bridge 探测失败（连续 {} 次）：{}'.format(bridge_fail, b_info))
            else:
                if bridge_fail:
                    say('🟢 Bridge 已恢复（此前连续失败 {} 次）'.format(bridge_fail))
                bridge_fail = 0

        if streak_ne >= args.max_not_eligible:
            post(base, '/api/pause')
            say('🛑 额度守卫触发：连续 {} 条「不符合重新测量资格」→ 已暂停。'
                '高度怀疑本月额度用尽，下月恢复后再跑剩余 {} 条。'.format(
                    streak_ne, len(pending)))
            break
        if streak_infra >= args.max_infra:
            post(base, '/api/pause')
            say('🛑 基础设施守卫触发：连续 {} 条基础设施失败 → 已暂停。'.format(streak_infra))
            break

        if (time.time() - last_change) > args.stall_minutes * 60:
            say('⚠️ 停滞告警：已 {} 分钟无任何状态变化（不自动暂停，请人工确认）。'.format(
                args.stall_minutes))
            last_change = time.time()

        if not pending and s.get('status') != 'running':
            say('✅ 队列已跑完 | 本批新增成功 {} | 本批新增失败 {}'.format(
                new_done, len(new_fails)))
            break

    try:
        s = fetch(base)
        new_done = len(s.get('done') or []) - base_done
        nf = (s.get('failed') or [])[base_fail:]
        say('📋 小结 | 本批新增成功 {} | 新增失败 {}（其中「不符合资格」{} 条）| 剩余待处理 {}'.format(
            new_done, len(nf),
            sum(1 for f in nf if classify(f.get('reason')) == 'NOT_ELIGIBLE'),
            len(s.get('pending') or [])))
    except Exception:
        pass
    if logf:
        logf.close()


if __name__ == '__main__':
    main()
