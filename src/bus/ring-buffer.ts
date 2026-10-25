/**
 * 有界环形缓冲（L3）：同时按「条数」与「字节数」淘汰最旧事件。
 *
 * 不变量：容量固定，push 后 `size <= capacity` 且 `bytes <= byteCapacity`；
 * 单条事件若自身超过字节上限：清空缓冲并丢弃该条（保持字节不变量，计入 evicted）。
 */
export interface RingBufferOptions<T> {
  readonly capacity: number;
  readonly byteCapacity: number;
  readonly sizeOf: (item: T) => number;
}

export class RingBuffer<T> {
  readonly #capacity: number;
  readonly #byteCapacity: number;
  readonly #sizeOf: (item: T) => number;
  readonly #items: (T | undefined)[];
  #head = 0;
  #size = 0;
  #bytes = 0;
  #evicted = 0;

  constructor(options: RingBufferOptions<T>) {
    if (!Number.isSafeInteger(options.capacity) || options.capacity <= 0) {
      throw new TypeError("RingBuffer: capacity must be a positive safe integer");
    }
    if (!Number.isSafeInteger(options.byteCapacity) || options.byteCapacity <= 0) {
      throw new TypeError("RingBuffer: byteCapacity must be a positive safe integer");
    }
    this.#capacity = options.capacity;
    this.#byteCapacity = options.byteCapacity;
    this.#sizeOf = options.sizeOf;
    this.#items = new Array<T | undefined>(options.capacity);
  }

  get size(): number {
    return this.#size;
  }

  get bytes(): number {
    return this.#bytes;
  }

  get evicted(): number {
    return this.#evicted;
  }

  get capacity(): number {
    return this.#capacity;
  }

  push(item: T): void {
    const itemBytes = this.#sizeOf(item);
    while (this.#size > 0 && this.#bytes + itemBytes > this.#byteCapacity) this.#dropOldest();
    if (itemBytes > this.#byteCapacity) {
      while (this.#size > 0) this.#dropOldest();
      this.#evicted += 1; // 超限条目本身也不入缓冲（否则永久违反字节上限）
      return;
    }
    if (this.#size === this.#capacity) this.#dropOldest();
    const tail = (this.#head + this.#size) % this.#capacity;
    this.#items[tail] = item;
    this.#size += 1;
    this.#bytes += itemBytes;
  }

  #dropOldest(): void {
    const oldest = this.#items[this.#head];
    if (oldest === undefined) return;
    this.#bytes -= this.#sizeOf(oldest);
    this.#items[this.#head] = undefined;
    this.#head = (this.#head + 1) % this.#capacity;
    this.#size -= 1;
    this.#evicted += 1;
  }

  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.#size; i += 1) {
      const item = this.#items[(this.#head + i) % this.#capacity];
      if (item !== undefined) out.push(item);
    }
    return out;
  }

  clear(): void {
    this.#items.fill(undefined);
    this.#head = 0;
    this.#size = 0;
    this.#bytes = 0;
  }
}
