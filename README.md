# mocl — MOCL 兼容层（施工仓）

> 上游是**设计包**（`../docs`、`../.astra`、`../HANDOFF.md`），施工期**只读**。
> 本仓从施工切片 **C0（骨架）+ C1（ABI 类型与 schema 落地）** 开始；ABI 的语义真源是
> [`../docs/abi/abi-v0.md`](../docs/abi/abi-v0.md)，JSON Schema 真源是
> [`../docs/abi/schema/`](../docs/abi/schema/)（46 错误码 / 34 能力位 / 35 事件 / 18 方法）。

## 环境

- Node.js **>= 24**（`tools/validate-abi.mjs` 直接用 Node 内置 TS type-stripping 读取
  `src/abi/*.ts`，因此不需要先编译）
- pnpm 11（`packageManager` 由全局 pnpm 提供；本仓无 `packageManager` 锁定）

## 命令

```bash
cd impl
pnpm install                 # 安装 devDependencies（5 个：typescript/vitest/@types/node/ajv/ajv-formats）

pnpm -s sync:schema          # 设计包 docs/abi/schema → impl/schema（逐字节；差异会打印摘要）
pnpm -s sync:schema -- --check   # 只检查不写：与设计包不一致时 exit 1（CI 用）

pnpm -s typecheck            # tsc -p tsconfig.json --noEmit（strict + noUncheckedIndexedAccess）
pnpm -s test                 # vitest run（C1：6 个文件 / 47 个测试）
pnpm -s test -- --run        # 验收命令形式（等价，见 VERIFY.md）
node tools/validate-abi.mjs  # ABI 门禁：5 schema 编译 + 46/34/35/18 + fixtures
```

**schema 同步规则**：`docs/abi/schema/*.json` 是唯一真源；`impl/schema/` 是**逐字节副本**
（随仓库提交，供运行时校验与门禁使用）。**不要手改 `impl/schema/`**——改了会在下次
`sync:schema` 被覆盖；设计变更走设计包的 ABI §13 MINOR 流程，然后 `pnpm -s sync:schema`。

## 目录

```text
impl/
├── package.json / tsconfig.json / pnpm-workspace.yaml / .gitignore
├── README.md / VERIFY.md
├── schema/                     # ← 从 ../docs/abi/schema 同步；勿手改（5 个 schema）
│   ├── session.json  event.json  error.json  capabilities.json  request.json
├── src/abi/
│   ├── index.ts                # 公共入口（barrel）
│   ├── methods.ts              # 18 个 ABI 方法元数据（M1–M18；schema 冻结 M1–M9）
│   ├── errors.ts               # 46 错误码 + 12 分类 + retryable 映射（ABI §8.2）
│   ├── capabilities.ts         # 34 能力位（A 组 15 / B 组 19）+ missing/degraded 工具
│   ├── events.ts               # 35 事件类型 + 事件家族 + 终态事件
│   ├── types.ts                # 手写 wire 类型：Session/Event/Error/Capabilities/Request
│   └── validate.ts             # AJV 2020-12 运行时校验（编译缓存）
├── tools/
│   ├── sync-schema.mjs         # schema 同步（幂等 / --check / diff 摘要）
│   └── validate-abi.mjs        # ABI 门禁（计数 + 集合一致 + fixtures）
├── fixtures/                   # 9 条契约样例（5 合法 / 4 非法）+ manifest.json
│   ├── valid/    session · event.turn-completed · error.rate-limited
│   │             capabilities.codex · request.session-send
│   ├── invalid/  event.unknown-type · session.bad-state
│   │             error.missing-user-message · request.send-missing-idempotency
│   └── manifest.json
└── tests/abi/                  # 6 个测试文件（47 tests）
    ├── schema.test.ts  errors.test.ts  capabilities.test.ts
    ├── events.test.ts  requests.test.ts  fixtures.test.ts
```

## C0/C1 已落地内容

| 项 | 状态 | 验收证据 |
|---|---|---|
| 仓库骨架（package/tsconfig/gitignore/README） | ✅ | `pnpm -s typecheck` |
| schema 同步（真源 → 副本，幂等 + `--check`） | ✅ | `pnpm -s sync:schema` 输出 up-to-date |
| 手写 ABI 类型（5 类对象 + 35 事件 discriminated union） | ✅ | `pnpm -s typecheck` |
| 46 错误码 + retryable 映射 | ✅ | `validate-abi.mjs` + 6 tests |
| 34 能力位 + 交集工具 | ✅ | `validate-abi.mjs` + 6 tests |
| 18 方法注册表 | ✅ | `validate-abi.mjs` + 7 tests |
| AJV 运行时校验（5 schema，编译缓存） | ✅ | `validate-abi.mjs` + 11 tests |
| 契约 fixtures（合法/非法） | ✅ | `node tools/validate-abi.mjs`（9/9） |

## 边界与纪律

- 只写 `impl/`；`../docs`、`../.astra`、`../HANDOFF.md` 只读。
- 不引入凭据；不打印 token/key（fixtures 与测试均无凭据）。
- 发现「设计包与 schema/实现」冲突时：**停下并回报 Lead**，不自行改设计包。
- 后续切片（C2+）的写域见 `../.astra/PLAN.md` Part B：C2 `src/broker/`、C3 `src/bus/`、
  C4–C7 `src/adapters/`；本仓 ABI 层（`src/abi/`）对它们只读依赖。
