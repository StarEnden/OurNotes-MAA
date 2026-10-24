<p align="center">
  <img src="logo.png" width="200" alt="OurNotes MAA">
</p>

<h1 align="center">OUR NOTES 挂机助手</h1>

<p align="center">
  <img src="https://img.shields.io/github/stars/StarEnden/OurNotes-MAA?label=Stars" alt="Stars">
  <img src="https://img.shields.io/github/commit-activity/m/StarEnden/OurNotes-MAA?label=Commit%20Activity" alt="Commit Activity">
  <img src="https://img.shields.io/github/last-commit/StarEnden/OurNotes-MAA?label=Last%20Commit" alt="Last Commit">
  <img src="https://img.shields.io/github/license/StarEnden/OurNotes-MAA?label=License" alt="License">
</p>

《BanG Dream! Our Notes》的自动化小工具，基于 [MaaFramework](https://github.com/MaaXYZ/MaaFramework)。

> ⚠️ **风险提示**：脚本类自动化操作游戏可能违反游戏服务条款，存在账号风险，请自行评估使用。
> 作者不对任何账号损失负责。
**注意：目前只支持在游戏设置为简体中文语言下进行**

## 功能

**挂机**

- 启动游戏（自动从标题页推进到主界面）
- 挂机刷曲：演出时不进行点击

**每日领奖**

- TWG 积分＋TWG等级每日奖励
- 商店每日 Live Boost
- 通行证 pt（每日，适配多个通行证的情况）
- 任务奖励（每日·常规）
- 礼物盒奖励
- 录音室奖励

**其他**

- 使用跳过进行演出：可选跳过次数（1~3）与 LIVE BOOST 消耗档位
- 资源检查 / 更新

## 安装与配置

从 [Releases](../../releases) 下载最新版本的压缩包（`OurNotes-MAA-<版本>-win-x86_64.zip`），
解压到任意目录即可。

> 常见模拟器端口：MuMu 12 = `16384`，夜神 = `62001`，雷电 = `5555`。

## 运行

### 第 1 步 · 启动

双击解压目录里的 `MFAAvalonia.exe`。

若提示缺少运行库，先运行目录里的 `DependencySetup_依赖库安装_win.bat`
（需要 .NET 10 Desktop Runtime 与 VC++ 运行库）。

### 第 2 步 · 连接模拟器

1. 先**启动你的安卓模拟器**并下载和登录游戏，确认模拟器已开启 ADB 调试
2. 在 MFAAvalonia 的「设备连接」里选设备。
3. 连不上请尝试手动填：adb 路径选解压目录里的 `platform-tools/adb.exe`，
   地址填 `127.0.0.1:<端口>`（用 `adb devices` 查，MuMu 12 常见是 `16384`）

### 第 3 步 · 勾选任务并开始

在任务列表里勾选要跑的任务（日常那几项默认已勾选），点「开始」。

- 首次启动游戏会先处理客户端的数据下载弹窗，耗时较长，属正常
- 「挂机打歌（不进行操作）」默认不勾选，需要时手动打开
- 建议先只勾一项试跑，确认识别正常后再全开

## 注意实现

- 请注意模拟器分辨率，使用非1920x1080和1280x720分辨率的模拟器很有可能导致运行失败(待修复ing(

## 一些常见问题

- 部分 MuMu 环境下，MFAAvalonia 的「实时画面」可能无法显示，但不一定影响任务执行；如果任务日志能够持续识别并点击，通常可以继续使用
- 如果同时出现设备连接失败或截图失败，请删除 MFAAvalonia 中的设备配置后重新添加，并检查 ADB 路径与设备地址
- 模拟器端口不是固定值，MuMu 常见端口包括 `16384`、`16416` 等，请以 `adb devices` 显示的设备地址为准
