#!/usr/bin/env node
/**
 * OurNotes-MAA Node AgentServer
 *
 * 作用：只做“运行审计”，不改任何游戏行为。
 *   - 注册 Tasker sink：拿到每个任务的开始/结束/状态
 *   - 注册 Context sink：拿到节点命中、识别结果、动作结果、失败原因
 *   - 任务结束时写两处：
 *       logs/daily_YYYYMMDD.txt     给人看的当日流水（每个任务一段）
 *       logs/agent/runs_YYYYMMDD.jsonl  给程序看的完整明细
 *
 * 这样“任务全绿但什么都没领到”的假成功，可以直接从命中链路里看出来。
 *
 * 启动方式（由 Client 拉起，socket id 作为最后一个参数传入）：
 *   node agent/main.js <socket_id>
 */
const fs = require('fs');
const path = require('path');

const PROJECT = process.env.OURNOTES_PROJECT || path.resolve(__dirname, '..');
const MAA_BIN = process.env.MAA_BIN || path.join(PROJECT, 'MaaFramework', 'bin');

process.chdir(MAA_BIN);
const server = require(path.join(MAA_BIN, 'MaaNodeServer.node')).Server;

const LOG_ROOT = path.join(PROJECT, 'logs');
const AGENT_DIR = path.join(LOG_ROOT, 'agent');
const MAX_NODES = 5000;

const STATUS_TEXT = {
    1000: '等待',
    2000: '运行中',
    3000: '成功',
    4000: '失败',
    5000: '已取消',
};

const pad = (n) => String(n).padStart(2, '0');
function dateKey(d = new Date()) {
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}
function dayKey(d = new Date()) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function clock(d = new Date()) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function dailyPath(d = new Date()) {
    return path.join(LOG_ROOT, `daily_${dateKey(d)}.txt`);
}
function runsPath(d = new Date()) {
    return path.join(AGENT_DIR, `runs_${dateKey(d)}.jsonl`);
}

function append(file, text) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, text, 'utf8');
    } catch (e) {
        console.error('[agent] 写日志失败', file, e && e.message);
    }
}

/** 从框架的 reco_details 里抽出可读摘要 */
function summarizeReco(detail) {
    if (!detail) return null;
    const out = { algorithm: detail.algorithm || '', box: detail.box || null };
    const d = detail.detail;
    let best = null;
    if (Array.isArray(d)) {
        for (const sub of d) {
            const b = sub && (sub.best || (sub.filtered && sub.filtered[0]) || (sub.all && sub.all[0]));
            if (b) { best = b; break; }
        }
    } else if (d && typeof d === 'object') {
        best = d.best || (d.filtered && d.filtered[0]) || (d.all && d.all[0]) || null;
    }
    if (best) {
        if (best.text != null) out.text = best.text;
        if (best.score != null) out.score = Number(best.score.toFixed ? best.score.toFixed(3) : best.score);
        if (best.count != null) out.count = best.count;
        if (best.label != null) out.label = best.label;
        if (best.cls_index != null) out.cls_index = best.cls_index;
        if (best.box) out.box = best.box;
    }
    return out;
}

function recoLine(reco) {
    if (!reco) return '';
    const bits = [reco.algorithm || '?'];
    if (reco.text != null) bits.push(`"${reco.text}"`);
    if (reco.score != null) bits.push(`score=${reco.score}`);
    if (reco.count != null) bits.push(`count=${reco.count}`);
    return bits.join(' ');
}

/** 压缩连续重复节点：A ×3 → B */
function compressChain(names) {
    const out = [];
    for (const n of names) {
        const last = out[out.length - 1];
        if (last && last.name === n) last.count += 1;
        else out.push({ name: n, count: 1 });
    }
    return out;
}

const runs = new Map();

function getRun(taskId, entry) {
    let run = runs.get(taskId);
    if (!run) {
        run = {
            task_id: taskId,
            entry: entry || '?',
            start: new Date(),
            nodes: [],
            failures: [],
            counts: { pipeline: 0, recognition: 0, action: 0, nextlist_failed: 0 },
            truncated: false,
        };
        runs.set(taskId, run);
    } else if (entry && run.entry === '?') {
        run.entry = entry;
    }
    return run;
}

function onPipelineNode(run, msg) {
    // 注意：PipelineNode 通知里的 msg.name 是「任务入口名」，不是节点名；
    // 真正的节点名在 msg.node_details.name 里（Succeeded/Failed 才有）。
    const nodeName = (msg.node_details && msg.node_details.name) || msg.name || '?';
    if (msg.msg === 'PipelineNode.Starting') {
        run.current = { node_id: msg.node_id, at: Date.now() };
        return;
    }
    if (msg.msg === 'PipelineNode.Succeeded') {
        run.counts.pipeline += 1;
        if (run.nodes.length >= MAX_NODES) { run.truncated = true; return; }
        const cur = run.current && run.current.node_id === msg.node_id ? run.current : null;
        const reco = summarizeReco(msg.reco_details) || null;
        const action = msg.action_details
            ? { action: msg.action_details.action, success: msg.action_details.success }
            : null;
        run.nodes.push({
            name: nodeName,
            node_id: msg.node_id,
            t: clock(),
            ms: cur ? Date.now() - cur.at : null,
            reco,
            action,
            completed: msg.node_details ? msg.node_details.completed !== false : true,
        });
        return;
    }
    if (msg.msg === 'PipelineNode.Failed') {
        run.failures.push({
            stage: '节点',
            name: nodeName,
            t: clock(),
            reco: summarizeReco(msg.reco_details),
            action: msg.action_details
                ? { action: msg.action_details.action, success: msg.action_details.success }
                : null,
            reason: msg.reason || null,
        });
    }
}

function onContext(msg) {
    if (!msg || typeof msg !== 'object') return;
    const taskId = msg.task_id;
    if (taskId == null) return;
    const run = getRun(taskId);

    if (msg.msg.startsWith('PipelineNode.')) {
        onPipelineNode(run, msg);
        return;
    }
    if (msg.msg === 'Recognition.Succeeded') {
        run.counts.recognition += 1;
        if (run.current) run.current.reco = summarizeReco(msg.reco_details);
        return;
    }
    if (msg.msg === 'Recognition.Failed') {
        run.failures.push({
            stage: '识别',
            name: msg.name || '?',
            t: clock(),
            reco: summarizeReco(msg.reco_details),
            reason: msg.reason || null,
        });
        return;
    }
    if (msg.msg === 'Action.Succeeded') {
        run.counts.action += 1;
        const a = msg.action_details;
        if (run.current) run.current.action = a ? { action: a.action, success: a.success } : null;
        return;
    }
    if (msg.msg === 'Action.Failed') {
        const a = msg.action_details || {};
        run.failures.push({
            stage: '动作',
            name: msg.name || '?',
            t: clock(),
            action: { action: a.action, success: a.success },
            reason: msg.reason || null,
        });
        return;
    }
    if (msg.msg === 'NextList.Failed') {
        run.counts.nextlist_failed += 1;
        return;
    }
    if (msg.msg === 'NextList.Starting' && msg.list_type === 'on_error') {
        run.failures.push({
            stage: '兜底',
            name: msg.name || '?',
            t: clock(),
            reason: 'next 列表超时，进入 on_error',
        });
    }
}

function finalizeRun(run, status, reason, when = new Date()) {
    if (run.end) return;
    run.end = when;
    run.status = status;
    run.reason = reason || null;
    const duration = ((run.end - run.start) / 1000).toFixed(1);
    const date = dayKey(run.start);

    const chain = compressChain(run.nodes.map((n) => n.name));
    const chainText = chain.map((c) => (c.count > 1 ? `${c.name} ×${c.count}` : c.name)).join(' → ');
    const last = run.nodes[run.nodes.length - 1] || null;
    // 优先选“识别/动作失败”，其次才是笼统的节点失败（节点级往往是超时汇总，没信息量）
    const fail = [...run.failures].reverse().find((f) => f.stage !== '节点' && (f.reco || f.action))
        || run.failures[run.failures.length - 1]
        || null;
    const failCount = fail
        ? run.failures.filter((f) => f.name === fail.name && f.stage === fail.stage).length
        : 0;

    const mark = status === 3000 ? '✅' : status === 5000 ? '⏹' : '❌';
    const statusText = STATUS_TEXT[status] || `status=${status}`;
    let block = '';
    block += `[${clock(run.start)}–${clock(run.end)}] ${mark} ${run.entry}  ${statusText} ${duration}s` +
        `（节点 ${run.counts.pipeline} / 识别 ${run.counts.recognition} / 动作 ${run.counts.action}）\n`;
    if (chainText) block += `  链路: ${chainText}\n`;
    else block += '  链路: （没有命中任何节点）\n';
    if (status !== 3000 && fail) {
        block += `  失败于: ${fail.name}（${fail.stage}`;
        if (fail.reco && fail.reco.algorithm) block += ` ${fail.reco.algorithm}`;
        if (failCount > 1) block += `，${failCount} 次未命中`;
        block += '）';
        if (fail.reco) {
            const line = recoLine(fail.reco);
            if (line && line !== (fail.reco.algorithm || '')) block += ` ${line}`;
        }
        if (reason) block += ` 原因=${reason}`;
        block += '\n';
    } else if (status !== 3000) {
        block += `  失败原因: ${reason || '未记录'}\n`;
    }
    if (run.truncated) block += `  ⚠ 节点超过 ${MAX_NODES} 个，链路已截断（明细见 jsonl）\n`;
    block += '\n';

    append(dailyPath(run.start), block);

    const record = {
        type: 'run',
        date,
        entry: run.entry,
        task_id: String(run.task_id),
        status,
        status_text: statusText,
        start: run.start.toISOString(),
        end: run.end.toISOString(),
        duration_ms: run.end - run.start,
        counts: run.counts,
        chain,
        nodes: run.nodes.map((n) => ({
            name: n.name,
            node_id: String(n.node_id),
            t: n.t,
            ms: n.ms,
            reco: n.reco,
            action: n.action,
            completed: n.completed,
        })),
        failures: run.failures.slice(-50),
        truncated: run.truncated,
        last_node: last ? last.name : null,
    };
    append(runsPath(run.start), JSON.stringify(record) + '\n');
}

function finalizeOpen(reason) {
    for (const run of runs.values()) {
        if (!run.end) finalizeRun(run, 5000, reason, new Date());
    }
}

function taskerSink(_tsk, msg) {
    try {
        if (!msg || !msg.msg || !msg.task_id) return;
        if (msg.msg === 'Task.Starting') {
            getRun(msg.task_id, msg.entry);
            return;
        }
        if (msg.msg === 'Task.Succeeded') {
            finalizeRun(getRun(msg.task_id, msg.entry), 3000, null);
            runs.delete(msg.task_id);
            return;
        }
        if (msg.msg === 'Task.Failed') {
            finalizeRun(getRun(msg.task_id, msg.entry), 4000, msg.reason || null);
            runs.delete(msg.task_id);
            return;
        }
        if (msg.msg === 'Task.Cancelled') {
            finalizeRun(getRun(msg.task_id, msg.entry), 5000, msg.reason || null);
            runs.delete(msg.task_id);
        }
    } catch (e) {
        console.error('[agent] tasker sink 异常', e && e.message);
    }
}

function contextSink(_ctx, msg) {
    try {
        onContext(msg);
    } catch (e) {
        console.error('[agent] context sink 异常', e && e.message);
    }
}

function ensureHeader() {
    const file = dailyPath();
    try {
        if (!fs.existsSync(file)) {
            fs.mkdirSync(LOG_ROOT, { recursive: true });
            fs.writeFileSync(file,
                `OurNotes MAA 运行记录 ${dayKey()}\n` +
                `说明：✅成功 ❌失败 ⏹中断；“链路”= 实际命中的节点顺序（连续重复用 ×N 表示）\n` +
                '='.repeat(60) + '\n\n', 'utf8');
        }
    } catch (e) {
        console.error('[agent] 初始化日志失败', e && e.message);
    }
}

ensureHeader();
server.add_tasker_sink(taskerSink);
server.add_context_sink(contextSink);

const identifier = process.argv[process.argv.length - 1];
if (!identifier || identifier === process.argv[1]) {
    console.error('[agent] 缺少 socket identifier（应由 Client 作为最后一个参数传入）');
    process.exit(1);
}

let closing = false;
async function shutdown(signal) {
    if (closing) return;
    closing = true;
    try { finalizeOpen(`agent 收到 ${signal} 退出`); } catch (e) { /* ignore */ }
    try { await server.shut_down(); } catch (e) { /* ignore */ }
    process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('exit', () => { try { finalizeOpen('agent 进程退出'); } catch (e) { /* ignore */ } });

server.start_up(identifier).then((ok) => {
    if (!ok) {
        console.error('[agent] start_up 失败');
        process.exit(1);
    }
    console.log(`[agent] 已连接 ${identifier}`);
    return server.join();
}).then(() => {
    finalizeOpen('agent 连接结束');
    process.exit(0);
}).catch((e) => {
    console.error('[agent] 启动异常', e && e.message);
    process.exit(1);
});
