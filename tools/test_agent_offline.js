// Node Agent 离线自检：不连模拟器、不碰游戏，用 CustomController 跑两条 DirectHit 节点，
// 验证 agent 能收到 task/node 事件并把流水写进 logs/daily_YYYYMMDD.txt。
// 用法：node tools/test_agent_offline.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MAA_BIN, PROJECT } = require('./config');
const { attachAgent, dailyLogPath } = require('./agent_runtime');

process.chdir(MAA_BIN);
const maa = require(path.join(MAA_BIN, 'MaaNode.node'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ournotes-agent-selftest-'));
const resourceDir = path.join(tmp, 'resource');
fs.mkdirSync(path.join(resourceDir, 'pipeline'), { recursive: true });
fs.writeFileSync(path.join(resourceDir, 'pipeline', 'test.json'), JSON.stringify({
    TestEntry: {
        recognition: 'DirectHit',
        action: 'DoNothing',
        next: ['TestStep2'],
    },
    TestStep2: {
        recognition: 'DirectHit',
        action: 'DoNothing',
        next: [],
    },
    TestFail: {
        recognition: 'OCR',
        expected: '这段文字不存在',
        roi: [0, 0, 80, 40],
        action: 'DoNothing',
        timeout: 2000,
        next: [],
    },
}, null, 2), 'utf8');
maa.Global.log_dir = path.join(tmp, 'debug');
maa.Global.debug_mode = false;

async function main() {
    const png = fs.readFileSync(path.join(PROJECT, 'resource', 'image', 'claim_daily_btn.png'));
    const ctrl = new maa.CustomController({
        connect() { return true; },
        screencap() { return png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength); },
        click() { return true; },
        swipe() { return true; },
        get_info() { return JSON.stringify({ uuid: 'agent-selftest', resolution: { width: 1280, height: 720 } }); },
    });
    const conn = await ctrl.post_connection().wait();
    if (conn.status !== 3000) throw new Error(`控制器连接失败 status=${conn.status}`);

    const res = new maa.Resource();
    const loaded = await res.post_bundle(resourceDir).wait();
    if (loaded.status !== 3000) throw new Error(`资源加载失败 status=${loaded.status}`);

    const tskr = new maa.Tasker();
    tskr.controller = ctrl;
    tskr.resource = res;

    const agent = await attachAgent(maa, res, tskr, { projectRoot: tmp, verbose: true });
    if (!agent.enabled) throw new Error('Agent 未启用');

    const r = await tskr.post_task('TestEntry').wait();
    console.log(`task status=${r.status}`);
    const f = await tskr.post_task('TestFail').wait();
    console.log(`fail-case status=${f.status}（预期 4000）`);
    await agent.close();

    const logFile = dailyLogPath(tmp);
    if (!fs.existsSync(logFile)) throw new Error(`没有生成流水文件 ${logFile}`);
    const text = fs.readFileSync(logFile, 'utf8');
    const checks = [
        ['任务名', text.includes('TestEntry')],
        ['链路', text.includes('TestStep2')],
        ['成功标记', text.includes('✅')],
        ['节点计数', /节点 2 \/ 识别 2 \/ 动作 2/.test(text)],
        ['失败任务标记', text.includes('❌ TestFail')],
        ['失败节点', text.includes('失败于: TestFail')],
    ];
    console.log('\n--- 生成流水 ---\n' + text.trim() + '\n----------------\n');
    let failed = 0;
    for (const [name, ok] of checks) {
        console.log(`${ok ? '✔' : '✘'} ${name}`);
        if (!ok) failed += 1;
    }
    if (r.status !== 3000) failed += 1;
    if (f.status !== 4000) failed += 1;
    if (failed) throw new Error(`自检失败 ${failed} 项`);
    console.log(`\n自检通过。流水样例：${logFile}`);
}

main().then(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    process.exit(0);
}).catch((e) => {
    console.error('自检失败:', e && e.message);
    console.error(`临时目录保留用于排查：${tmp}`);
    process.exit(1);
});
