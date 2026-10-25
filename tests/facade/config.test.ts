import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_CONFIG,
  PARENT_PROGRESS_HARD_LIMITS,
  configDigest,
  enabledBackends,
  loadFacadeConfig,
  validateConfig,
} from "../../src/facade/config.ts";

describe("门面配置（安全默认 + 校验）", () => {
  it("默认最小权限：全局/四后端全 disabled、read-only、无危险档、并发 runtime", () => {
    expect(DEFAULT_CONFIG.global.enabled).toBe(false);
    expect(DEFAULT_CONFIG.global.maxConcurrent).toBe("runtime");
    expect(DEFAULT_CONFIG.global.dangerousModes.allowed).toBe(false);
    expect(DEFAULT_CONFIG.global.progress).toMatchObject({
      mode: "off",
      maxItemsPerTurn: PARENT_PROGRESS_HARD_LIMITS.maxItemsPerTurn,
      maxCharsPerTurn: PARENT_PROGRESS_HARD_LIMITS.maxCharsPerTurn,
      maxCharsPerItem: PARENT_PROGRESS_HARD_LIMITS.maxCharsPerItem,
    });
    for (const id of ["codex", "kimi", "claude-code", "opencode"] as const) {
      expect(DEFAULT_CONFIG.backends[id]).toMatchObject({
        enabled: false,
        permissionMode: "read-only",
        allowDangerousModes: false,
        maxConcurrent: "runtime",
        worktreeIsolation: "required-for-write",
      });
    }
    expect(enabledBackends(DEFAULT_CONFIG)).toEqual([]);
  });

  it("config.default.json 与代码内默认值逐字段一致", async () => {
    const loaded = await loadFacadeConfig();
    expect(loaded).toEqual(DEFAULT_CONFIG);
  });

  it("未知键 → ConfigError（不静默忽略拼写错误）", () => {
    expect(() => validateConfig({ global: { enabled: true, typoKey: 1 } })).toThrow(ConfigError);
    expect(() => validateConfig({ backends: { codex: { nope: true } } })).toThrow(ConfigError);
  });

  it("yolo 需要 global.dangerousModes.allowed + backend.allowDangerousModes + worktree!=off", () => {
    expect(() =>
      validateConfig({ backends: { codex: { permissionMode: "yolo" } } }),
    ).toThrow(ConfigError);
    expect(() =>
      validateConfig({
        global: { dangerousModes: { allowed: true } },
        backends: { codex: { permissionMode: "yolo", allowDangerousModes: true } },
      }),
    ).not.toThrow();
    expect(() =>
      validateConfig({
        global: { dangerousModes: { allowed: true } },
        backends: { codex: { permissionMode: "yolo", allowDangerousModes: true, worktreeIsolation: "off" } },
      }),
    ).toThrow(ConfigError);
  });

  it("父级进度硬上限不可突破（8 / 1200 / 400）", () => {
    expect(() => validateConfig({ global: { progress: { maxItemsPerTurn: 9 } } })).toThrow(ConfigError);
    expect(() => validateConfig({ global: { progress: { maxCharsPerTurn: 1201 } } })).toThrow(ConfigError);
    expect(() => validateConfig({ global: { progress: { maxCharsPerItem: 401 } } })).toThrow(ConfigError);
  });

  it("maxConcurrent 只接受 \"runtime\" 或正整数", () => {
    expect(validateConfig({ global: { maxConcurrent: 2 } }).global.maxConcurrent).toBe(2);
    for (const bad of [0, -1, 1.5, "20"]) {
      expect(() => validateConfig({ global: { maxConcurrent: bad } })).toThrow(ConfigError);
    }
  });

  it("maxDepth 范围 1..3；越界拒绝", () => {
    expect(validateConfig({ global: { maxDepth: 3 } }).global.maxDepth).toBe(3);
    expect(() => validateConfig({ global: { maxDepth: 4 } })).toThrow(ConfigError);
    expect(() => validateConfig({ global: { maxDepth: 0 } })).toThrow(ConfigError);
  });

  it("深合并保留默认并覆盖子字段", () => {
    const config = validateConfig({ backends: { opencode: { enabled: true, model: "custom/model" } } });
    expect(config.backends.opencode.enabled).toBe(true);
    expect(config.backends.opencode.model).toBe("custom/model");
    expect(config.backends.opencode.fallbackModel).toBe("opencode/deepseek-v4.1-flash-free");
    expect(config.backends.opencode.permissionMode).toBe("read-only");
  });

  it("enabledBackends 只返回显式开启的，顺序固定", () => {
    const config = validateConfig({ backends: { kimi: { enabled: true }, codex: { enabled: true } } });
    expect(enabledBackends(config)).toEqual(["codex", "kimi"]);
  });

  it("configDigest 不含凭据且包含四后端与并发策略", () => {
    const digest = configDigest(DEFAULT_CONFIG);
    expect(digest).not.toMatch(/token|secret|api[_-]?key|auth/i);
    expect(JSON.parse(digest).backends).toHaveLength(4);
    expect(JSON.parse(digest).maxConcurrent).toBe("runtime");
  });
});
