# MGS 光储充四情景配置评估平台

## 软件定位

本软件面向校园/公共机构光储充场站的配置与运行决策。当前主线已经收敛为三模块：

```text
M1 离网基准配置生成
→ M2 四情景运行评价
→ M3 四情景配置优化与方案推荐
```

## 当前主链

- M1：基于全年 EV 初始需求 D0 与全年 TMY / 城市合成气象生成 S0 离网基础配置。
- M2：用 S0 在“离网/并网 × 规则运行/优化调度”四情景下进行压力月评价。
- M3：围绕 S0 生成 PV、储能和 PCS 候选方案，充电桩数量固定沿用 M1 SLA 定容结果，分别优化 C1-C4 四套情景最优配置，并做横向成本与风险比较。

## 核心文件

- `src/worker/scenario-core.js`：统一需求生成、桩服务、气象辐照、四情景能量仿真和成本口径。
- `src/worker/m1-engine.js`：S0 离网基准配置生成。
- `src/worker/m2-engine.js`：S0 四情景运行评价。
- `src/worker/m3-engine.js`：C1-C4 四情景配置优化。
- `src/worker/solver.worker.js`：Worker 任务分发入口。

## 快速检查

```bash
node scripts/smoke-test.mjs
```
