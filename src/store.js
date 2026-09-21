import { mkdir, open, readFile, truncate } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = 1;
const COMMIT = "COMMIT";

/**
 * 仅追加的事件日志。
 *
 * 每次业务变更组成一个批次：若干条事件行 + 一行提交标记。
 * 重放时，只有看到提交标记的批次才会投影到内存状态——
 * 进程在写入中途崩溃留下的残缺批次会被整体丢弃，
 * 因此预约与等待队列不会停留在“半个事务”里。
 */
class EventLog {
  constructor(file) {
    this.file = file;
    this.fh = null;
  }

  async init() {
    await mkdir(dirname(this.file), { recursive: true });
    this.fh = await open(this.file, "a");
  }

  async readCommittedBatches() {
    let buffer;
    try {
      buffer = await readFile(this.file);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    if (buffer.length === 0) return [];
    const text = buffer.toString("utf8");

    // 单写入者保证批次不会交错。逐行扫描，记录每个完整提交批次结束时的字节偏移；
    // 文件末尾任何没有 COMMIT 的内容（含写了一半的残行）都会被整体截断。
    const batches = [];
    const pending = new Map();
    let goodByteLength = 0;
    let lineStart = 0;

    for (let lineEnd = 0; ; ) {
      const newline = text.indexOf("\n", lineStart);
      if (newline === -1) break;
      const line = text.slice(lineStart, newline);
      lineEnd = newline + 1;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        break; // 残行：到此为止，后面全部丢弃
      }
      if (record.kind === COMMIT) {
        const events = pending.get(record.batchId);
        if (events && events.length === record.count) {
          batches.push(events);
          goodByteLength = Buffer.byteLength(text.slice(0, lineEnd));
          pending.delete(record.batchId);
        } else {
          break;
        }
      } else {
        if (!pending.has(record.batchId)) pending.set(record.batchId, []);
        pending.get(record.batchId).push(record);
      }
      lineStart = lineEnd;
    }

    if (goodByteLength < buffer.length) {
      await truncate(this.file, goodByteLength);
    }
    return batches;
  }

  async appendBatch(records) {
    const chunk = records.map((record) => JSON.stringify(record) + "\n").join("");
    await this.fh.appendFile(chunk);
    await this.fh.sync();
  }

  async close() {
    if (this.fh) await this.fh.close();
    this.fh = null;
  }
}

function createInitialState() {
  return {
    seq: 0,
    sites: new Map(), // siteId -> site
    staff: new Map(), // staffId -> { id, name, district, role, active }
    reservations: new Map(), // reservationId -> reservation
    waiting: new Map(), // siteId -> reservationId[]（严格 FIFO）
    idempotency: new Map(), // key -> 登记结果
    events: [], // 已提交事件，顺序即 seq 顺序
  };
}

/** 把一条事件投影到内存状态；必须无副作用、可重复重放。 */
function apply(state, record) {
  const { seq, at, type, data, actor } = record;
  const event = { seq, at, type, data, actor };
  state.events.push(event);

  switch (type) {
    case "SITE_REGISTERED": {
      state.sites.set(data.site.id, {
        ...data.site,
        zones: new Map(data.site.zones.map((zone) => [zone.id, zone])),
      });
      state.waiting.set(data.site.id, []);
      break;
    }
    case "STAFF_REGISTERED": {
      state.staff.set(data.staff.id, { ...data.staff, active: true });
      break;
    }
    case "RESERVATION_CONFIRMED": {
      state.reservations.set(data.reservation.id, { ...data.reservation, status: "confirmed" });
      break;
    }
    case "WAITLISTED": {
      state.reservations.set(data.reservation.id, { ...data.reservation, status: "waiting" });
      state.waiting.get(data.reservation.siteId).push(data.reservation.id);
      break;
    }
    case "PROMOTED": {
      const reservation = state.reservations.get(data.reservationId);
      reservation.status = "confirmed";
      reservation.zoneId = data.zoneId;
      const queue = state.waiting.get(reservation.siteId);
      queue.splice(queue.indexOf(data.reservationId), 1);
      break;
    }
    case "CANCELLED": {
      const reservation = state.reservations.get(data.reservationId);
      reservation.status = "cancelled";
      const queue = state.waiting.get(reservation.siteId);
      const index = queue.indexOf(data.reservationId);
      if (index !== -1) queue.splice(index, 1);
      break;
    }
    case "CHECKED_IN": {
      state.reservations.get(data.reservationId).status = "checked_in";
      break;
    }
    case "MARKED_NO_SHOW": {
      state.reservations.get(data.reservationId).status = "no_show";
      break;
    }
    case "REASSIGNED": {
      const reservation = state.reservations.get(data.reservationId);
      if (reservation.status === "waiting") {
        if (data.fromSiteId !== data.toSiteId) {
          const oldQueue = state.waiting.get(data.fromSiteId);
          oldQueue.splice(oldQueue.indexOf(data.reservationId), 1);
          if (data.newStatus === "waiting") state.waiting.get(data.toSiteId).push(data.reservationId);
        } else if (data.newStatus !== "waiting") {
          const queue = state.waiting.get(data.toSiteId);
          queue.splice(queue.indexOf(data.reservationId), 1);
        }
      }
      reservation.siteId = data.toSiteId;
      reservation.zoneId = data.toZoneId;
      reservation.zonePreference = data.zonePreference ?? null;
      if (data.newStatus) reservation.status = data.newStatus;
      break;
    }
    case "IDEMPOTENCY_RECORDED": {
      state.idempotency.set(data.key, {
        payloadHash: data.payloadHash,
        staffId: data.staffId,
        reservationId: data.reservationId,
        outcome: data.outcome,
      });
      break;
    }
    default:
      // 未知事件类型：保留在日志里但不投影，向前兼容。
      break;
  }
}

export class Store {
  constructor({ dataDir, now = () => Date.now() } = {}) {
    const resolved =
      dataDir ??
      (isAbsolute(process.env.DATA_DIR ?? "")
        ? process.env.DATA_DIR
        : join(dirname(fileURLToPath(import.meta.url)), "..", process.env.DATA_DIR ?? "data"));
    this.log = new EventLog(join(resolved, "events.log"));
    this.now = now;
    this.state = createInitialState();
    this.#queue = Promise.resolve();
  }

  #queue;

  async init() {
    await this.log.init();
    const batches = await this.log.readCommittedBatches();
    for (const events of batches) {
      for (const record of events) {
        this.state.seq = Math.max(this.state.seq, record.seq);
        apply(this.state, record);
      }
    }
  }

  async close() {
    await this.log.close();
  }

  /**
   * 串行执行一次变更：handler 读取最新状态并返回 { events, result }，
   * 事件先整体落盘（含提交标记），成功后才投影到内存。
   */
  mutate(handler) {
    const run = this.#queue.then(async () => {
      const produced = await handler(this.state);
      if (!produced || !Array.isArray(produced.events)) {
        throw new Error("变更处理器必须返回 { events, result }");
      }
      // 零事件（如幂等重放）直接返回，不产生空批次。
      if (produced.events.length === 0) {
        return typeof produced.result === "function" ? produced.result() : produced.result;
      }
      const batchId = randomUUID();
      const records = produced.events.map((event) => ({
        v: SCHEMA_VERSION,
        kind: "EVENT",
        batchId,
        seq: ++this.state.seq,
        at: this.now(),
        type: event.type,
        data: event.data ?? {},
        actor: event.actor ?? { kind: "system" },
      }));
      records.push({
        v: SCHEMA_VERSION,
        kind: COMMIT,
        batchId,
        seq: ++this.state.seq,
        at: this.now(),
        count: produced.events.length,
      });
      await this.log.appendBatch(records);
      for (const record of records) {
        if (record.kind !== COMMIT) apply(this.state, record);
      }
      // result 可以是函数，在投影完成后读取最新状态构造返回值。
      return typeof produced.result === "function" ? produced.result() : produced.result;
    });
    // 失败也要放行队列，但不吞掉调用方看到的错误。
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
