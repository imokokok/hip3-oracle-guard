# hip3-oracle-guard

HIP-3 deployer 喂价守卫——开源参考实现。防止你的 500k HYPE 质押因为一次喂价事故被烧掉。

> **为什么存在**：2026-07-28，单一盘前报价穿过 xyz:SKHYNIX 的 oracle 输入，$57.4M 清算、960 个账户。Trade.xyz 自愿全额赔付。HIP-3 罚没规则不区分恶意与无能——忠实执行一个糟糕的喂价设计，验证者同样可以烧掉你的质押（最高 100%）。
>
> 这个库把"喂价不出事"需要的守卫逻辑做成标准件：滞后检测、偏离熔断、discovery bound 校验、休市定价参考实现。

## 状态

**开发阶段**。验证报告见 [`research/VALIDATION-REPORT.md`](research/VALIDATION-REPORT.md)（含实测数据与竞争格局分析），SK Hynix 事故复盘见 [`docs/postmortem/2026-07-28-sk-hynix.md`](docs/postmortem/2026-07-28-sk-hynix.md)。

## 模块

| 模块 | 职责 | 状态 |
|---|---|---|
| `staleness` | 喂价滞后检测：上次更新距今、预期更新间隔、停滞告警 | ✅ 已实现（测试覆盖） |
| `deviation` | oracle vs mark / 外部参考的偏离度守卫，分级熔断，含验证者 ±50% 自动审查线标记 | ✅ 已实现（测试覆盖） |
| `bounds` | Discovery Bounds v2 校验：休市带、re-anchor 触发、带外清算豁免判定 | ✅ 已实现（测试覆盖） |
| `offhours` | 非 7x24 资产休市定价参考实现（对照 Trade.xyz 公开机制） | 规划中 |
| `halt-guard` | haltTrading 决策辅助：触发条件核对、事后结算价格核算 | 规划中 |
| `monitor` | 全生态只读监控：`scripts/sample-oracles.mjs`（零依赖采样器，GitHub Actions 每 30 分钟落快照到 data 分支） | 🟡 最小种子已上线 |

## 快速开始

```bash
npm install && npm test

# 看一眼整个 HIP-3 生态的喂价健康度（只读，无需任何密钥）
npm run sample

# 守卫库对真实生态的实时体检：对全部资产跑 deviation + bounds 守卫，输出分级告警
npm run build && node scripts/guard.mjs
```

## 你会踩的坑（本 README 的正文就是为此存在）

以下是部署方喂价体系里已发生或必然发生的失败模式，每一条最终都会对应本库的一个守卫模块：

1. **弃养即死亡。**实测：生态内 7/10 个 DEX 喂价停滞、交易量归零，oracle 与 mark 偏离最高 48%。喂价运维不是上线时的一次性工作，是持续成本——停更的那一刻市场就开始死。
2. **单一外部报价可以定义你的市场。**SK Hynix 事件：mark price 三输入中两个由 deployer 控制，一笔不真实的盘前成交就能穿透。你的输入源清单里每一个"上游报价"都是攻击面。
3. **discovery bound 是双刃剑。**±1/maxLeverage 的休市带防止插针清算，但 band re-anchor 机制（v2 的 90% 触发）设计不当会让周末漂移变成周一跳变。每个市场的杠杆档位对应不同的 band 参数，抄错一行就是清算事故。
4. **休市定价是独立子系统。**股票盘后/周末、商品结算窗口（如 17:00-18:00 ET 维护时段）、节假日日历、股票分拆（Kioxia 3-for-1 实例）——每一个都需要预发布结算方案，而不是临时拍脑袋。
5. **罚没不看动机。**规则原文：恶意、粗心、忠实执行糟糕规格，同等适用。你的喂价设计有没有被第二双眼睛审过？
6. **oracleUpdater 是单点。**外包给第三方 updater（如 RedStone 模式）省了运维，但把命门交给了别人；自建则要自己背 3 秒更新间隔的全天候 SLA。两条路的守卫逻辑不同。

## 适用对象

- 正在筹备 HIP-3 部署的团队（Dutch auction 拿到 namespace 之后、上线之前）
- 已上线但喂价栈是"能跑就行"级别的中小 deployer
- 不想把数据层整个外包给 RedStone、又造不出头部自建栈的团队

## 不做什么

- 不做喂价数据本身（那是 RedStone 等数据商的位置）
- 不托管任何人的生产喂价——本库只读、只告警、只校验
- 不承诺"用了就不会被罚没"——罚没权在验证者手里

## License

MIT
