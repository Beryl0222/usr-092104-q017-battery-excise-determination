# 锂电池消费税判定与凭证后端

保存法规版本、生效区间、产品技术分类、组成物料、检验报告、生产批次、应税时点、计税价格、发票、申报批次与更正分录的事件溯源后端。基础数据交换沿用仓库领域事件（`STOCK_INBOUND/OUTBOUND/RETURNED`）。

## 核心原则

1. **税率由可核验技术属性与法定时点共同决定**：市场/商品名称不参与判定，只留档审计（改名产品会被检验报告实测值矛盾拦截）。
2. **法规是带时区的左闭右开区间** `[effective_from, effective_to)`，全部按绝对时刻比较；2%→4% 阶梯与阶段性免税到期可在任意边界日期、任意时区重放。
3. **分类可建议、边界必签署**：系统列出候选分类与缺失证据；非边界且证据齐备才自动确认；半固态灰区、混合储能模组等边界产品必须由授权角色（`authorized_classification_officer` / `tax_director`）签署 `CLASSIFICATION_SIGNED`，并引用已核验证据。
4. **应税时点决定版本**：按结算方式（预收发货、赊销约定收款日、直接收款）确定，先开发票的以开票日为准；合同签订、完工入库、开票、出库跨生效日时不会套错版本。
5. **申报与原分录不可变**：退货、折让、用途变化、税务复核只产生 `ENTRY_ADJUSTED`（`reversal` 冲正 / `supplement` 补提），归属更正发生当期的申报批次；原 `ENTRY_POSTED`、`FILING_SUBMITTED` 永不修改。
6. **不重复计税**：同一计税结论只能进入一个申报批次；模组连续生产领用已税电芯，凭上游已纳税凭证扣除，扣除额封顶于应纳税额。
7. **每笔税额可解释**：`TAX_CALCULATED.explanation` 内嵌适用法规及区间、分类证据（自动/签署）、应税时点依据与事实、计税价格依据、扣除依据与计算公式。

## 目录

- `contracts/domain.schema.json`：事件信封与事件/聚合枚举、载荷约定。
- `src/validator.js`：信封与载荷硬约束校验（时区、授权角色、证据核验、更正引用等）。
- `src/domain/`
  - `catalog.js` 技术分类目录与候选规则（阈值一处定义）
  - `rules.js` 法规版本时间线、区间解析（应税/免税重叠裁决）、边界枚举
  - `classification.js` 技术档案/证据投影、矛盾检测、候选与缺失证据、签署结论
  - `operations.js` 批次/BOM/仓库事件/合同/发票投影
  - `taxpoint.js` 应税时点判定
  - `assessment.js` 计税与解释对象
  - `vouchers.js` 会计分录、不可变申报、冲正/补提计划与申报汇总
  - `audit.js` 整车/储能模组 → 所含批次 → 计税 → 申报 → 更正的递归追溯
  - `store.js` 只追加事件日志与 as-of 重放
- `src/service.js`：判定应用服务（重放事实 → 税点事件 + 计税事件或阻断原因）。
- `scenarios/september-switch.js`：九月政策切换全景事实数据。
- `tests/contract.test.js`：领域一致性与场景测试。

## 事件总览

`RULE_VERSION_PUBLISHED / RULE_REPEALED`、`TECHNICAL_PROFILE_REGISTERED`、`EVIDENCE_SUBMITTED`、`CLASSIFICATION_PROPOSED / CLASSIFICATION_SIGNED`、`PRODUCTION_LOT_RECORDED / COMPONENT_CONSUMED`、`STOCK_INBOUND / STOCK_OUTBOUND / STOCK_RETURNED`、`CONTRACT_SIGNED`、`TAX_POINT_DETERMINED`、`INVOICE_ISSUED / INVOICE_RED_ISSUED`、`TAX_CALCULATED`、`ENTRY_POSTED / ENTRY_ADJUSTED`、`FILING_SUBMITTED`。

## 本地检查

```bash
npm test
```
