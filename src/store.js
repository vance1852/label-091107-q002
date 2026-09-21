// 追加式事件日志：唯一的持久化来源。
// 每条事件以 append + flush 落盘，启动时重放恢复内存状态与等待次序。

import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  appendFileSync,
  fsyncSync,
} from "node:fs";
import { dirname } from "node:path";
import { initialState, applyEvent } from "./domain.js";

export class EventStore {
  constructor(filePath) {
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    const existed = existsSync(filePath);
    this.fd = openSync(filePath, "a");
    this.state = initialState();
    if (existed) this.#replay();
  }

  #replay() {
    const text = readFileSync(this.filePath, "utf8");
    for (const [index, line] of text.split("\n").entries()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch (error) {
        throw new Error(`事件日志第 ${index + 1} 行损坏：${error.message}`);
      }
      applyEvent(this.state, event);
    }
  }

  // 串行写入由 service 层的互斥锁保证；这里再兜底校验序号。
  commit(event) {
    const seq = this.state.events.length + 1;
    const stored = { seq, at: new Date().toISOString(), ...event };
    appendFileSync(this.fd, `${JSON.stringify(stored)}\n`);
    fsyncSync(this.fd);
    applyEvent(this.state, stored);
    return stored;
  }

  events() {
    return [...this.state.events];
  }

  close() {
    closeSync(this.fd);
  }
}
