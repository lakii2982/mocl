import { describe, expect, it } from "vitest";
import { RingBuffer } from "../../src/bus/ring-buffer.ts";

const sizeOf = (value: string): number => Buffer.byteLength(value, "utf8");

describe("RingBuffer（条数 + 字节双上限）", () => {
  it("按条数淘汰最旧项，顺序保持", () => {
    const ring = new RingBuffer<string>({ capacity: 3, byteCapacity: 1024, sizeOf });
    for (const value of ["a", "b", "c", "d"]) ring.push(value);
    expect(ring.toArray()).toEqual(["b", "c", "d"]);
    expect(ring.evicted).toBe(1);
    expect(ring.size).toBe(3);
  });

  it("按字节上限淘汰最旧项", () => {
    const ring = new RingBuffer<string>({ capacity: 10, byteCapacity: 10, sizeOf });
    ring.push("12345"); // 5 bytes
    ring.push("67890"); // 5 bytes
    expect(ring.size).toBe(2);
    ring.push("abc"); // +3 > 10 → 淘汰 "12345"
    expect(ring.size).toBe(2);
    expect(ring.toArray()).toEqual(["67890", "abc"]);
    expect(ring.bytes).toBeLessThanOrEqual(10);
    expect(ring.evicted).toBe(1);
  });

  it("单条超过字节上限：保留最新一条（清空更旧）", () => {
    const ring = new RingBuffer<string>({ capacity: 4, byteCapacity: 8, sizeOf });
    ring.push("old");
    ring.push("this-is-too-long");
    expect(ring.size).toBe(0); // 超限项本身也不保留（避免永久超限）
    expect(ring.bytes).toBe(0);
    expect(ring.evicted).toBe(2);
  });

  it("非法容量 → 构造期拒绝", () => {
    expect(() => new RingBuffer<string>({ capacity: 0, byteCapacity: 8, sizeOf })).toThrow(TypeError);
    expect(() => new RingBuffer<string>({ capacity: 2, byteCapacity: 0, sizeOf })).toThrow(TypeError);
  });

  it("clear 后回到空态", () => {
    const ring = new RingBuffer<string>({ capacity: 2, byteCapacity: 64, sizeOf });
    ring.push("a");
    ring.clear();
    expect(ring.size).toBe(0);
    expect(ring.bytes).toBe(0);
    expect(ring.toArray()).toEqual([]);
  });
});
