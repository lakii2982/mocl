# opencode fixtures（C7）

来源：2026-10-26 本机真实 `opencode v2.1.4` 复测（免费模型池 `opencode/deepseek-v4.1-flash-free`，
HTTP v2 服务 `127.0.0.1:49374`）。所有帧已**脱敏**：sessionID 保留前缀、不含任何凭据/Authorization。

- `sse-success.jsonl`：成功一轮的 SSE 帧序列（含 catalog 噪声与内部标记，用于验证丢弃计数）。
- `sse-auth-expired.jsonl`：付费模型 401 `api_key_expired` 的失败帧（D-019 降级触发）。
- `catalog-noise.jsonl`：工程元数据噪声帧（integration/provider/model/agent/... updated）。

用法：`tests/adapters/opencode/*.test.ts` 逐行 JSON.parse 后送入 `OpenCodeEventMapper`；
不得在本目录出现 service.json 内容或 password。
