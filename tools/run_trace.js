// 追踪版：打印 Maa 全部上下文事件（含识别框、动作、点击坐标）
// 用法: node run_trace.js <入口节点> ['<override JSON>']
const path = require('path');
const { MAA_BIN, ADB, ADDR, PROJECT } = require('./config');

process.chdir(MAA_BIN);
const maa = require(path.join(MAA_BIN, 'MaaNode.node'));
maa.Global.log_dir = path.join(PROJECT, 'debug');
maa.Global.debug_mode = true;
maa.Global.save_draw = true;

const entry = process.argv[2];
const override = process.argv[3] ? JSON.parse(process.argv[3]) : null;
if (!entry) { console.error('用法: node run_trace.js <入口节点> ["<override>"]'); process.exit(1); }

async function main() {
    const ctrl = new maa.AdbController(ADB, ADDR, '6', '7', '{}');
    const conn = await ctrl.post_connection().wait();
    if (conn.status !== 3000) { console.error('连接失败 status=', conn.status); process.exit(1); }
    const res = new maa.Resource();
    const b = await res.post_bundle(path.join(PROJECT, 'resource')).wait();
    if (b.status !== 3000) { console.error('资源加载失败 status=', b.status); process.exit(1); }

    const tskr = new maa.Tasker();
    tskr.add_context_sink((_, m) => {
        if (!m || typeof m !== 'object') return;
        const parts = [m.msg];
        if (m.name) parts.push('name=' + m.name);
        if (m.detail) {
            let d = m.detail;
            try { d = JSON.stringify(JSON.parse(d)); } catch (e) { /* 原样 */ }
            parts.push('detail=' + String(d).slice(0, 300));
        }
        console.log('[' + m.msg + '] ' + parts.slice(1).join(' '));
    });
    tskr.controller = ctrl;
    tskr.resource = res;

    const r = override ? await tskr.post_task(entry, override).wait() : await tskr.post_task(entry).wait();
    console.log('--- 结束 status=' + r.status + ' ---');
    process.exit(0);
}
main().catch(e => { console.error('异常', e); process.exit(1); });
