# HIP-3 Oracle Guard 验证报告

日期：2026-11-25 · 数据源：Hyperliquid 公开 API 实测 + Web 检索 · 结论：**有条件 GO**

## 一、实测数据（api.hyperliquid.xyz，2026-11-25）

### Deployer 名单（10 DEX / 9 deployer）

| DEX | Deployer | OracleUpdater | 资产数 | 24h 交易量 |
|---|---|---|---|---|
| xyz (Trade.xyz) | 0x8880…f888 | **null（自建，部署方密钥直接推）** | 141 | **$4,853M（占 98%+）** |
| io (Entropy) | 0x320c…ac6 | 0x9475…ed5（**RedStone**） | 19 | $68M |
| para (Paragon) | 0x8888…ed3 | 自有地址 | 34 | $8.9M |
| mkts (Kinetiq) | 0x71f0…ec | null | 5 | $0.1M |
| hyna / flx / km / cash / vntl / abcd | — | — | — | **≈ 0（僵尸化）** |

### 喂价偏离实测（335 个资产快照）

- 最大偏离：hyna:LIT **48.4%**、flx:BTC **29.3%**（oracle 64,705 vs mark 91,470）、cash:INTC **19.9%**
- 全部为 **OI=0、交易量=0 的弃养市场**——喂价停滞 → 市场死亡的完整样本
- 结论：**"oracle 停滞"失败模式在生态内普遍存在**，是真实的、可量化的现象

## 二、事故与罚没证据

**SK Hynix 事件（2026-07-28）**：
- 韩国 NXT 盘前一笔 1 股报价（127.2 万韩元，较收盘隐含 -28.7%）被 oracle 视为有效输入
- xyz:SKHYNIX 永续暴跌 19%（discovery bound 封顶），**$57.4M 清算、960 个账户**
- Hyperliquid 撇清（HIP-3 deployer 自营），Trade.xyz **自愿全额赔付全部清算损失**
- 罚没规则：不区分恶意/无能/忠实执行糟糕设计，最高可烧 100% 质押；分档 20%（性能退化）/ 50%（短停机）/ 100%（无效状态）
- 事发时 Trade.xyz 未发布 post-mortem，平台事后加速重审定价方式、提高自家订单簿权重

## 三、竞争格局（关键修正）

| 层 | 占据者 | 状态 |
|---|---|---|
| 喂价数据服务（outsourcing oracle ops） | **RedStone**（Entropy+Felix 共用 updater 已证实） | 已被占 |
| 头部自建 + 自研守卫 | Trade.xyz（relayer 3s、Discovery Bounds v2、re-anchoring、backstop liquidator） | 已被占，且刚经历事故后加码 |
| **守卫/监控/风险工具层**（偏离告警、halt 守卫、休市定价校验、事故复盘工具） | **无人做** | 空 |
| 面向新 deployer 的开源参考实现 | 无人做 | 空 |

## 四、判断

### 支持 GO
1. 痛点被协议规则强制化：罚没条款覆盖"忠实执行糟糕设计"，且 deployer 还面临自愿赔付+声誉损失（SK Hynix 实证）
2. 失败模式普遍且可量化（弃养市场 oracle 偏离 20-48%）
3. 中小 deployer（para、km、cash 等）与未来新 deployer 既付不起/不愿被 RedStone 锁定，又造不出 Trade.xyz 级别的自建栈——开源参考实现是他们的唯一选项
4. 位置空：RedStone 卖数据，Trade.xyz 自用，守卫层无人做

### 强制边界
1. **不做喂价数据服务**——那是 RedStone 的位置，正面竞争必死
2. **不指望 Trade.xyz 采用**——它是自建派，把它当研究对象而非客户
3. **收入预期锚定在生态位生意**：9 个 deployer、3 个活的，天花板低；真正回报是生态可见性 + HyperFoundation grant 通道 + 第二方采用信号
4. **单一生态依赖**：这是 Hyperliquid 篮子里的第三个鸡蛋（Insight、PriorSeal 之外），需接受命运绑定

### 一票否决检验（已执行，通过）
链上实测证明脆弱模式真实存在（弃养市场 + SK Hynix $57M 事故），不是想象中的痛点。

## 五、MVP 边界（若开工）

1. `hip3-oracle-guard` npm 包：喂价滞后/偏离守卫、discovery bound 边界校验、halt 前告警、休市定价参考实现（对照 Trade.xyz 公开机制）
2. 托管只读监控 demo（CF Workers，免费额度）：实时展示全生态 oracle 健康度
3. 旗舰内容：SK Hynix 事故完整技术复盘（协议机制 + 数据复现）——deployer 会搜的东西，也是能力证明
4. 数据源：info API（metaAndAssetCtxs/perpDexs）+ WebSocket 轮询采样，全部只读

## 六、下一步

1. 短期采样（1-2 周）：对活着的 3 个 DEX 做连续喂价采样，量化偏离/滞后分布（报告的第三块数据）
2. 写 SK Hynix 复盘（首个公开交付物）
3. 骨架 + README 按"坑"组织
4. 关注 HyperFoundation grants 通道与 HIP-3 新 deployer 入场动态

*原始数据：data/perpDexs.json、data/ctxs-*.json*
