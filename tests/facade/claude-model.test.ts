/**
 * W4（issue #20）验收：claude-code 真实链路的 `runtime.model` / `modelSource`。
 *
 * 用真实 `ClaudeCodeAdapter`（注入假 SDK，零额度）走 facade.open → send → 事件流：
 * - `system/init.model` 实测 → `turn.started.model` → `runtime.model` 非空、`modelSource="reported"`；
 * - init 不带 model（配置 `model:null`）→ `runtime.model=null`、`modelSource="unknown"`——
 *   拿不到就保持 null，不编造（W4 §3）。
 */
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code/index.ts";
import { FakeQuery, FakeSdk, initMessage, makeHarness, makeWorkdir, tick } from "../adapters/claude-code/helpers.ts";
import type { SdkMessage, SdkUserMessage } from "../../src/adapters/claude-code/types.ts";
import { enabledConfig, makeFacade, type FacadeFixture } from "./helpers.ts";

/** open 时自动补发 `system/init` 的假 SDK（stream 模式下 init 在首个输入后才到）。 */
class AutoInitSdk extends FakeSdk {
  readonly #initOverrides: Record<string, unknown>;
  constructor(initOverrides: Record<string, unknown> = {}) {
    super();
    this.#initOverrides = initOverrides;
  }
  override query(params: { prompt: string | AsyncIterable<SdkUserMessage>; options: Record<string, unknown> }): FakeQuery {
    const query = super.query(params);
    const sessionId = params.options["sessionId"];
    queueMicrotask(() => {
      query.push(
        initMessage({
          // 适配器 open 时用 Options.sessionId 钉死会话 id；init 必须回带同一 id
          ...(typeof sessionId === "string" ? { session_id: sessionId } : {}),
          ...this.#initOverrides,
        }),
      );
    });
    return query;
  }
}

/**
 * 首个轮内事件（`message_start`）：映射器在它前面补发每轮恰一条的 `turn.started`（W4）。
 * 必须在 `facade.open` 返回后注入——open 内部的 send 已登记 turn，此时注入才能稳定触发
 * （与 init 同一微任务推送会在 send 登记前被 readLoop 消费，turn.started 不会发出）。
 */
const messageStart = (model: string | undefined): SdkMessage =>
  ({
    type: "stream_event",
    event: { type: "message_start", message: { id: "msg_1", role: "assistant", model, content: [] } },
    parent_tool_use_id: null,
    uuid: "u1",
  }) as unknown as SdkMessage;

async function makeClaudeFacade(
  sdk: AutoInitSdk,
): Promise<FacadeFixture & { readonly adapter: ClaudeCodeAdapter; readonly sdk: AutoInitSdk }> {
  const harness = makeHarness({ sdk: sdk as unknown as FakeSdk, adapter: { model: null } });
  const fixture = await makeFacade({
    config: enabledConfig({ enabled: ["claude-code"] }),
    adapters: { "claude-code": harness.adapter },
  });
  return { ...fixture, adapter: harness.adapter, sdk };
}

type StatusOf = Awaited<ReturnType<FacadeFixture["facade"]["status"]>>;

async function pollStatus(
  fixture: FacadeFixture,
  childId: string,
  until: (runtime: { model: string | null; modelSource: string }, lastEventType: string | null) => boolean,
  timeoutMs = 2_000,
): Promise<StatusOf> {
  const deadline = Date.now() + timeoutMs;
  let status = await fixture.facade.status(childId);
  while (!until(status.runtime, status.lastEventType)) {
    if (Date.now() > deadline) throw new Error(`pollStatus timeout: lastEventType=${String(status.lastEventType)}`);
    await tick();
    status = await fixture.facade.status(childId);
  }
  return status;
}

describe("W4 验收：claude-code 的 runtime.model / modelSource（facade 投影）", () => {
  it("init 实测 model → turn.started → runtime.model 非空且 modelSource=reported", async () => {
    const workdir = await makeWorkdir();
    const fixture = await makeClaudeFacade(new AutoInitSdk()); // init.model = claude-sonnet-5（helpers 默认）
    try {
      const opened = await fixture.facade.open("claude-code", "W4 冒烟：回报实际模型", { cwd: workdir.dir });
      // message_start 带流内 fallback 值：本轮 turn.started 必须仍用 init 实测值
      // （回归「message_start 抢跑覆盖 turn.started」缺陷——修前此处得到 claude-fallback-3）。
      fixture.sdk.queries[0]?.push(messageStart("claude-fallback-3"));
      const status = await pollStatus(fixture, opened.childId, (runtime) => runtime.modelSource === "reported");
      expect(status.runtime.model).toBe("claude-sonnet-5");
      expect(status.runtime.modelSource).toBe("reported");
      await fixture.facade.close(opened.childId);
    } finally {
      await fixture.cleanup();
      await workdir.cleanup();
    }
  });

  it("init 不带 model（配置 null）→ runtime.model=null 且 modelSource=unknown（不编造）", async () => {
    const workdir = await makeWorkdir();
    const fixture = await makeClaudeFacade(new AutoInitSdk({ model: undefined }));
    try {
      const opened = await fixture.facade.open("claude-code", "W4 冒烟：无实测模型", { cwd: workdir.dir });
      // init 不带 model 且 message_start 也不带 → turn.started.model 必须是空串，而不是编造值。
      fixture.sdk.queries[0]?.push(messageStart(undefined));
      // 等 turn.started 真正被消费后再断言"未上报"。message.started 与 turn.started 同批
      // （message_start → [turn.started, message.started]，微任务内连续入库），lastEventType
      // 停在批内最后一条，故以 message.started 作为「turn.started 已消费」的信号。
      const status = await pollStatus(
        fixture,
        opened.childId,
        (_runtime, lastEventType) => lastEventType === "message.started",
      );
      expect(status.runtime.model).toBeNull();
      expect(status.runtime.modelSource).toBe("unknown");
      await fixture.facade.close(opened.childId);
    } finally {
      await fixture.cleanup();
      await workdir.cleanup();
    }
  });
});
