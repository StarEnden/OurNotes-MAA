// 给 CLI 跑任务脚本挂上 Node Agent（运行审计）
//
// 用法（在 run_task_override.js / run_daily.js 里）：
//   const { attachAgent } = require('./agent_runtime');
//   const agent = await attachAgent(maa, res, tskr, { verbose: false });
//   ...跑任务...
//   await agent.close();
//
// 关闭方式：环境变量 OURNOTES_AGENT=0
// 说明：Agent 只读事件、不改变任务行为；连不上时自动降级为“不挂 Agent”，任务照常跑。
const path = require('path');
const { spawn } = require('child_process');
const { PROJECT, MAA_BIN } = require('./config');

const CONNECT_TIMEOUT_MS = 15000;
let unavailable = false;

function dateKey(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function dailyLogPath(projectRoot = PROJECT, d = new Date()) {
    return path.join(projectRoot, 'logs', `daily_${dateKey(d)}.txt`);
}

/**
 * @param {object} maa     运行中的 MaaNode 模块
 * @param {object} res    已加载的 Resource
 * @param {object} tskr    待执行的 Tasker
 * @param {{verbose?: boolean}} [opts]
 * @returns {Promise<{enabled: boolean, identifier?: string, close: () => Promise<void>, logPath: string}>}
 */
async function attachAgent(maa, res, tskr, opts = {}) {
    const projectRoot = opts.projectRoot || PROJECT;
    const logPath = dailyLogPath(projectRoot);
    const disabled = {
        enabled: false,
        logPath,
        async close() { /* 未启用，无需收尾 */ },
    };

    if (process.env.OURNOTES_AGENT === '0') return disabled;
    if (unavailable) return disabled;
    if (!maa || typeof maa.Client !== 'function') {
        console.warn('[agent] 当前 MaaNode 不含 Client，跳过运行审计');
        unavailable = true;
        return disabled;
    }

    let script = path.join(projectRoot, 'agent', 'main.js');
    if (!require('fs').existsSync(script)) script = path.join(PROJECT, 'agent', 'main.js');
    if (!require('fs').existsSync(script)) {
        console.warn('[agent] 未找到 agent/main.js（发行包默认不含 agent），跳过运行审计');
        unavailable = true;
        return disabled;
    }

    let client;
    let child;
    try {
        client = new maa.Client();
        const identifier = client.identifier;

        child = spawn(process.execPath, [script, identifier], {
            cwd: projectRoot,
            env: Object.assign({}, process.env, { OURNOTES_PROJECT: projectRoot, MAA_BIN }),
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        child.stdout.on('data', (d) => {
            if (opts.verbose) console.log('[agent]', String(d).trim());
        });
        child.stderr.on('data', (d) => {
            const text = String(d).trim();
            if (text) console.warn('[agent]', text);
        });
        child.on('exit', (code, signal) => {
            if (opts.verbose && code) console.warn(`[agent] 退出 code=${code} signal=${signal || ''}`);
        });

        client.bind_resource(res);
        client.register_tasker_sink(tskr);

        await Promise.race([
            client.connect(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('连接 Agent 超时')), CONNECT_TIMEOUT_MS)),
        ]);

        return {
            enabled: true,
            identifier,
            logPath,
            async close() {
                try { client.disconnect(); } catch (e) { /* ignore */ }
                try { client.destroy(); } catch (e) { /* ignore */ }
                if (child && !child.killed) {
                    try { child.kill(); } catch (e) { /* ignore */ }
                }
                // 给 agent 一点时间把最后一段流水写完
                await new Promise((r) => setTimeout(r, 300));
            },
        };
    } catch (e) {
        unavailable = true;
        console.warn('[agent] 挂载失败，降级为不记录运行审计:', e && e.message);
        try { if (client) client.disconnect(); } catch (err) { /* ignore */ }
        try { if (client) client.destroy(); } catch (err) { /* ignore */ }
        try { if (child && !child.killed) child.kill(); } catch (err) { /* ignore */ }
        return disabled;
    }
}

module.exports = { attachAgent, dailyLogPath };
