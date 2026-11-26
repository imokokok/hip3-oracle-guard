# hip3-oracle-guard

HIP-3 deployer 喂价守卫——开源参考实现。防止你的 500k HYPE 质押因为一次喂价事故被烧掉。

> **为什么存在**：2026-07-28，单一盘前报价穿过 xyz:SKHYNIX 的 oracle 输入，$57.4M 清算、960 个账户。Trade.xyz 自愿全额赔付。HIP-3 罚没规则不区分恶意与无能——忠实执行一个糟糕的喂价设计，验证者同样可以烧掉你的质押（最高 100%）。
>
> 这个库把"喂价不出事"需要的守卫逻辑做成标准件：滞后检测、偏离熔断、discovery bound 校验、休市定价参考实现。

## 状态

**开发阶段**。验证报告见 [`research/VALIDATION-REPORT.md`](research/VALIDATION-REPORT.md)（含实测数据与竞争格局分析），SK Hynix 事故复盘见 [`docs/postmortem/2026-07-28-sk-hynix.md`](docs/postmortem/2026-07-28-sk-hynix.md)。

📊 **[HIP-3 喂价健康度实时状态页](https://imokokok.github.io/hip3-oracle-guard/)** — 全部 HIP-3 DEX 的 oracle/mark 偏离、OI、24h 量，由采样 workflow 自动刷新（GitHub Actions 调度为尽力而为，实际频率取决于其负载）。

## 模块

| 模块 | 职责 | 状态 |
|---|---|---|
| `staleness` | 喂价滞后检测：上次更新距今、预期更新间隔、停滞告警 | ✅ 已实现（测试覆盖） |
| `deviation` | oracle vs mark / 外部参考的偏离度守卫，分级熔断，含验证者 ±50% 自动审查线标记 | ✅ 已实现（测试覆盖） |
| `bounds` | Discovery Bounds v2 校验：休市带、re-anchor 触发、带外清算豁免判定 | ✅ 已实现（测试覆盖） |
| `offhours` | 会话感知休市守卫：美股/CME 期货/外汇会话日历（ET 含夏令时），休市期 band 约束 | ✅ 已实现（测试覆盖） |
| `halt-guard` | 验证者审查线接近度 + halt 前核对清单（结构化输出，决策权留给部署方） | ✅ 已实现（测试覆盖） |
| `monitor` | 常驻守护进程 + 采样器：oracle 变化检测实现真实 staleness；GitHub Actions 每 30 分钟落快照 | ✅ 已上线（实跑验证） |

## 快速开始

```bash
npm install && npm test

# 看一眼整个 HIP-3 生态的喂价健康度（只读，无需任何密钥）
npm run sample

# 守卫库对真实生态的实时体检：对全部资产跑 deviation 守卫，输出分级告警
npm run build && node scripts/guard.mjs

# 常驻监控（真实 staleness：oracle 值变化检测），告警以 JSONL 输出
npm run build && MONITOR_OUT=alarms.jsonl node scripts/monitor.mjs
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

## 已知限制（诚实声明）

- **bounds 需要 band anchor。**协议真实 band anchor 不由快照 API 暴露。用 markPx/prevDayPx 等近似值替代时，必须在 `BoundsConfig.referenceApproximate` 显式声明——声明后 critical 自动降级为 warn 并在 reason 标注，防止近似锚虚报最高级告警。`scripts/guard.mjs` 的实时体检因此只跑 deviation（2026-11-25 起：此前的 markPx 自比实现会让 bounds 恒报 ok，属于虚假覆盖，已移除）。
- **staleness 冷启动。**差分推断模式（monitor.mjs 的 oracle 变化检测）在进程启动后的窗口内无法区分"feed 停了"和"观测者刚启动"——窗口内告警 severity 封顶 warn 并置 `coldStart: true`（库层：`StalenessConfig.firstObservedAtMs`）。硬时间戳模式（快照含更新时间）不受影响。
- **节假日日历未内置。**offhours 模块按常规周会话表判定，节假日会被误判为开市。
- **monitor 无状态。**进程重启即丢失观测历史，重启后重新进入冷启动窗口；持久化留待真实使用需求出现时再加。

## License

MIT
