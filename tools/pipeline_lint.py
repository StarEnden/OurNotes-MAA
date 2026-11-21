#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
管线图检查（离线，不连设备）

查三类问题：
  1. 悬空引用：next / on_error / interrupt 指向不存在的节点
  2. 死节点：没有任何前驱、也不是任务入口（写了但永远不执行）
     - description 里写了「备用/保留/不接/未接/可选/已废/停用」的算「保留分支」，只提示不告警
  3. 高危环：环里的 DirectHit + Click 节点没有 max_hit（无条件命中 + 盲点，最容易空转）

用法：
  python tools/pipeline_lint.py            # 只报错，不因警告返回非 0
  python tools/pipeline_lint.py --strict   # 有警告也返回 2（给 CI / 发版前用）
  python tools/pipeline_lint.py --json
退出码：0=无错误；2=有错误（--strict 时有警告也返回 2）
"""
import argparse
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PIPELINE_DIR = os.path.join(ROOT, "resource", "pipeline")
INTERFACE = os.path.join(ROOT, "interface.json")
EDGE_KEYS = ("next", "on_error", "interrupt")

# interface.json 之外、由 CLI 工具直接调用的入口（run_daily / run_task_override）
CLI_ENTRIES = {"HomeConfirm", "TWGPoints", "DailyTWG"}
RESERVED_HINTS = ("备用", "保留", "不接", "未接", "可选", "已废", "停用", "未启用", "backup")


def strip_line_comments(text):
    """去掉 // 行注释（字符串内的 // 不动）。只用于 interface.json 这类 JSONC。"""
    out, i, n, instr, esc = [], 0, len(text), False, False
    while i < n:
        c = text[i]
        if instr:
            out.append(c)
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                instr = False
            i += 1
        else:
            if c == '"':
                instr = True
                out.append(c)
                i += 1
            elif c == "/" and i + 1 < n and text[i + 1] == "/":
                while i < n and text[i] != "\n":
                    i += 1
            else:
                out.append(c)
                i += 1
    return "".join(out)


def load_json(path, allow_comments=False):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    if allow_comments:
        text = strip_line_comments(text)
    return json.loads(text)


def node_type(value):
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return value.get("type") or value.get("recognition") or "?"
    return "?"


def refs_of(node):
    out = []
    for key in EDGE_KEYS:
        for ref in node.get(key) or []:
            if isinstance(ref, str):
                out.append((key, ref))
    return out


def load_entries():
    data = load_json(INTERFACE, allow_comments=True)
    entries = set(CLI_ENTRIES)
    for task in data.get("task") or []:
        entry = task.get("entry")
        if isinstance(entry, str):
            entries.add(entry)
        elif isinstance(entry, list):
            entries.update(x for x in entry if isinstance(x, str))
    return entries


def load_nodes():
    nodes = {}
    files = {}
    duplicates = []
    for name in sorted(os.listdir(PIPELINE_DIR)):
        if not name.endswith(".json"):
            continue
        path = os.path.join(PIPELINE_DIR, name)
        try:
            data = load_json(path)
        except Exception as e:
            print(f"[错误] {name} 不是合法 JSON：{e}")
            continue
        if not isinstance(data, dict):
            continue
        for node_name, node in data.items():
            if not isinstance(node, dict):
                continue
            if node_name in nodes:
                duplicates.append((node_name, files[node_name], name))
            nodes[node_name] = node
            files[node_name] = name
    return nodes, files, duplicates


def tarjan(nodes):
    index = [0]
    indices = {}
    low = {}
    stack = []
    on_stack = set()
    sccs = []

    def strongconnect(v):
        indices[v] = index[0]
        low[v] = index[0]
        index[0] += 1
        stack.append(v)
        on_stack.add(v)
        for _, w in refs_of(nodes[v]):
            if w not in nodes:
                continue
            if w not in indices:
                strongconnect(w)
                low[v] = min(low[v], low[w])
            elif w in on_stack:
                low[v] = min(low[v], indices[w])
        if low[v] == indices[v]:
            scc = []
            while True:
                w = stack.pop()
                on_stack.discard(w)
                scc.append(w)
                if w == v:
                    break
            if len(scc) > 1 or any(w == v for _, w in refs_of(nodes[v])):
                sccs.append(sorted(scc))
    for v in nodes:
        if v not in indices:
            strongconnect(v)
    return sccs


def cycle_label(scc):
    if len(scc) <= 8:
        return " → ".join(scc)
    return " → ".join(scc[:6]) + f" …（共 {len(scc)} 个节点）"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--strict", action="store_true", help="有警告也返回 2")
    args = ap.parse_args()

    entries = load_entries()
    nodes, files, duplicates = load_nodes()

    errors = []
    warnings = []
    infos = []

    for node_name, f1, f2 in duplicates:
        errors.append(f"[重复节点] {node_name} 同时出现在 {f1} 与 {f2}（全局节点名必须唯一）")

    incoming = {name: set() for name in nodes}
    for name, node in nodes.items():
        for key, ref in refs_of(node):
            if ref in nodes:
                if ref != name:
                    incoming[ref].add(name)
            else:
                errors.append(f"[悬空引用] {files[name]} 的节点 {name}.{key} → {ref} 不存在")

    for name, refs in incoming.items():
        if refs or name in entries:
            continue
        node = nodes[name]
        desc = str(node.get("description") or "")
        if any(h in desc for h in RESERVED_HINTS):
            infos.append(f"[保留分支] {files[name]} 的节点 {name}（description 标明备用/不接）")
        else:
            warnings.append(
                f"[死节点] {files[name]} 的节点 {name}（识别={node_type(node.get('recognition'))}，"
                f"动作={node_type(node.get('action'))}）没有任何前驱，也不是任务入口"
            )

    sccs = tarjan(nodes)
    for scc in sccs:
        limited = [n for n in scc if isinstance(nodes[n].get("max_hit"), int) and nodes[n].get("max_hit", 0) > 0]
        blind = [
            n for n in scc
            if node_type(nodes[n].get("recognition")) == "DirectHit"
            and node_type(nodes[n].get("action")) == "Click"
            and not (isinstance(nodes[n].get("max_hit"), int) and nodes[n].get("max_hit", 0) > 0)
        ]
        if blind:
            warnings.append("[高危环] DirectHit+Click 盲点节点在环里且无 max_hit: " + ", ".join(blind))
        if not limited and len(scc) <= 3:
            warnings.append("[无兜底环] 小环上没有任何 max_hit: " + " → ".join(scc))
        infos.append(
            f"[环] {cycle_label(scc)}" + (f"；max_hit 兜底: {', '.join(limited)}" if limited else "；无 max_hit")
        )

    result = {
        "errors": errors,
        "warnings": warnings,
        "infos": infos,
        "node_count": len(nodes),
        "entry_count": len(entries),
    }

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"检查了 {len(nodes)} 个节点 / {len(entries)} 个任务入口")
        for e in errors:
            print(e)
        for w in warnings:
            print(w)
        for i in infos:
            print(i)
        if not errors and not warnings:
            print("✅ 管线图检查通过：无悬空引用、无死节点、无高危环")
        else:
            print(f"\n共 {len(errors)} 个错误 / {len(warnings)} 个警告 / {len(infos)} 条提示")

    if errors:
        return 2
    if args.strict and warnings:
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
