// 查看某天的 Agent 运行审计（读 logs/agent/runs_YYYYMMDD.jsonl）
// 用法:
//   node tools/agent_report.js            # 今天
//   node tools/agent_report.js 20261120   # 指定日期（YYYYMMDD 或 YYYY-MM-DD）
const fs = require('fs');
const path = require('path');
const { PROJECT } = require('./config');

function normalizeDate(input) {
    if (!input) {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
    }
    return String(input).replace(/-/g, '');
}

const day = normalizeDate(process.argv[2]);
const file = path.join(PROJECT, 'logs', 'agent', `runs_${day}.jsonl`);
if (!fs.existsSync(file)) {
    console.error(`没有找到运行记录：${file}`);
    process.exit(1);
}

const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
const runs = [];
for (const line of lines) {
    try {
        const r = JSON.parse(line);
        if (r && r.type === 'run') runs.push(r);
    } catch (e) { /* 跳过坏行 */ }
}

const STATUS = { 3000: '✅成功', 4000: '❌失败', 5000: '⏹中断' };
function chainText(run) {
    if (!run.chain || !run.chain.length) return '—';
    return run.chain.map((c) => (c.count > 1 ? `${c.name} ×${c.count}` : c.name)).join(' → ');
}
function clock(iso) {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

console.log(`OurNotes MAA 运行审计 ${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}（${runs.length} 次）`);
console.log('时间        任务            状态    用时     节点  链路');
for (const r of runs) {
    const used = `${(r.duration_ms / 1000).toFixed(1)}s`.padEnd(7);
    const status = (STATUS[r.status] || `status=${r.status}`).padEnd(6);
    console.log(`${clock(r.start)}–${clock(r.end)}  ${String(r.entry).padEnd(14)} ${status} ${used} ${String(r.counts.pipeline).padStart(4)}  ${chainText(r)}`);
    if (r.status !== 3000 && r.failures && r.failures.length) {
        const f = r.failures[r.failures.length - 1];
        console.log(`                          失败于 ${f.name}（${f.stage}）${f.reco && f.reco.text ? ` "${f.reco.text}"` : ''}`);
    }
}

const ok = runs.filter((r) => r.status === 3000).length;
const bad = runs.length - ok;
console.log(`\n汇总：成功 ${ok} / 失败 ${bad}`);
process.exit(bad ? 1 : 0);
