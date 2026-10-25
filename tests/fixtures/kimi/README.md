# kimi 录制帧（C6 契约测试的"录制回放"素材）

来源：本机 kimi-code **2.3.1**（`~/.kimi-code/bin/kimi`）实测，采集脚本见 `repro/probe-kimi.sh`。
全部为**真实线格式**，仅做了三件处理：

1. 去掉体积大的 `availableCommands[]`（13 条 slash command）与 `configOptions[].options[]`（10 个模型别名），
   用 `"…"` 占位并保留关键键；
2. session id 保留原样（`session_<uuid>` 不是凭据）；
3. 不包含任何 token / api_key / OAuth 值。

| 文件 | 内容 | 对应规格 |
|---|---|---|
| `acp-initialize.jsonl` | `initialize` 的 JSON-RPC 响应 | §2.2 握手 / K1 |
| `acp-session-new.jsonl` | `session/new` 响应（含 configOptions + modes） | §3.1 / §3.2 / K4 |
| `acp-updates.jsonl` | `session/update` 通知序列（thought/message/tool_call/tool_call_update/usage） | §5.2 #6–#16 |
| `acp-permission-request.jsonl` | `session/request_permission` 反向请求（Write，被拒后文件未创建） | §7.2 / K5 |
| `acp-cancel-method-not-found.jsonl` | `session/cancel` → `-32601` | D-008 / K6 |
| `cli-stream-json.jsonl` | `-p --output-format stream-json` 的三种事件 | §5.2 #19–#20 兜底通道 |
