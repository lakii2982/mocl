# 验收标准（D8）

> 每条都可执行。施工会话交付前必须逐条打勾并附命令输出。

## 一、设计包验收（本阶段，已由 `tools/check_docs.py` 覆盖）

| ID | 验收项 | 命令 | 状态 |
|---|---|---|---|
| A1 | 能力矩阵完整且有证据 | `python3 tools/check_docs.py matrix` | ☐ |
| A2 | 架构含分层/数据流/状态机/失败模式 | `python3 tools/check_docs.py arch` | ☐ |
| A3 | ABI 含 schema/版本协商/错误分类/能力位 | `python3 tools/check_docs.py abi` | ☐ |
| A4 | 四份适配器规格 12 小节齐全 | `python3 tools/check_docs.py adapters` | ☐ |
| A5 | 接入方案含取舍与推荐 | `python3 tools/check_docs.py integration` | ☐ |
| A6 | 风险登记册 ≥20 条 | `python3 tools/check_docs.py risk` | ☐ |
| A7 | 威胁模型覆盖 5 类 | `python3 tools/check_docs.py risk` | ☐ |
| A8 | 测试计划四要素 | `python3 tools/check_docs.py test` | ☐ |
| A9 | 独立评审记录 | `python3 tools/check_docs.py review` | ☐ |
| A10 | 施工切片可执行 | `python3 tools/check_docs.py plan` | ☐ |
| A11 | 探测命令可复跑 | `bash repro/run_all.sh` | ☐ |

## 二、施工阶段验收（交接给新会话）

### 功能验收

| ID | 验收项 | 判定 |
|---|---|---|
| F1 | 四个后端各自可被 DSH 派发一次任务 | 四条命令各自返回成功 + 子代理产出正确 |
| F2 | 至少三个后端支持「同一会话第二轮续接」 | CT-4 用例绿；上下文真的延续 |
| F3 | 至少一个后端支持「崩溃后冷恢复」 | FI-1 绿：kill 后按 id 恢复并取回结果 |
| F4 | 进度可增量读取且不超过父会话上限 | FI-6 绿 + 父消息数断言 |
| F5 | 嵌套子代理可被观察到（数量/角色）且深度受限 | FI-11 绿 |
| F6 | 统一入口能列出所有后端与各自能力位 | `status` 输出含 backend × capability |

### 非功能验收

| ID | 验收项 | 判定 |
|---|---|---|
| N1 | 默认配置下不产生任何文件写入 | SEC-4 绿 |
| N2 | 日志与事件无凭据泄漏 | SEC-5 绿 |
| N3 | 无残留进程/端口/socket | E2E-1 断言绿 |
| N4 | 断电式 kill 后重启可自愈 | FI-12 绿 |
| N5 | 单任务成本可归集 | usage 事件累计与账单抽样一致（±10%） |
| N6 | 卸载后可干净重装 | R20 用例绿 |

### 交付物验收

| ID | 交付物 | 判定 |
|---|---|---|
| D1 | 可运行的插件包（含 README 与示例配置） | `pnpm pack` 产物 + 安装步骤可照做 |
| D2 | 四后端冒烟脚本 | `pnpm -s smoke -- --backend=<b>` 全绿 |
| D3 | 录制回放套件 | `pnpm -s test:replay` 全绿 |
| D4 | 运行手册（含故障处置） | 手册内每条命令可执行 |
| D5 | 风险登记册终态（逐条标注已缓解/遗留） | 无"未处理且无兜底"的条目 |

## 三、不通过条件（任一命中即拒收）

1. 任何后端"看起来支持"但未在契约测试里验证；
2. `unknown` 错误分类占比 > 5%；
3. 默认配置具备写入或危险权限；
4. 父会话被进度淹没（超过配置上限）；
5. 存在无法 unwind 的进程/端口/socket 残留；
6. 文档中的能力断言与本机实测不一致（以实测为准，文档必须改）。

## 四、签收

- 设计包签收人：用户（本阶段）
- 施工签收人：用户 + 独立评审（施工会话内另建 fresh judge）
- 签收时必须附：`python3 tools/check_docs.py all` 输出、`bash repro/run_all.sh` 输出、评审结论。
