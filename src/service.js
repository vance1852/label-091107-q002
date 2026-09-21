// 业务规则层：所有变更在同一互斥队列内“校验 -> 提交事件 -> 级联递补”，
// 因此整户预约要么完全成功，要么进入候补；不会出现部分占床或超卖。

import { randomUUID } from "node:crypto";

export class ServiceError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const MAX_REASON_LENGTH = 200;

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ServiceError(400, "INVALID_REQUEST", `字段 ${field} 必须是非空字符串`);
  }
  return value.trim();
}

function requireReason(value) {
  const reason = requireNonEmptyString(value, "reason");
  if (reason.length > MAX_REASON_LENGTH) {
    throw new ServiceError(400, "INVALID_REQUEST", `原因长度不得超过 ${MAX_REASON_LENGTH} 字`);
  }
  return reason;
}

function requirePositiveInt(value, field, max = 10_000) {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new ServiceError(400, "INVALID_REQUEST", `字段 ${field} 必须是 1 到 ${max} 的整数`);
  }
  return value;
}

// 在一个分区内挑选床位：无障碍床位只分配给有无障碍需求的成员，
// 普通成员使用普通床；任一类不够则整户放不下（不可拆分，也不挪用无障碍床）。
// 返回床号数组；放不下返回 null。
function pickBedsInZone(zone, size, accessibleNeed) {
  const freeAccessible = zone.beds.filter((bed) => bed.accessible && bed.reservationId === null);
  const freeRegular = zone.beds.filter((bed) => !bed.accessible && bed.reservationId === null);
  if (freeAccessible.length < accessibleNeed) return null;
  if (freeRegular.length < size - accessibleNeed) return null;
  return [
    ...freeAccessible.slice(0, accessibleNeed).map((bed) => bed.id),
    ...freeRegular.slice(0, size - accessibleNeed).map((bed) => bed.id),
  ];
}

// 在避难所范围内确定安置分区与床位。指定 requestedZoneCode 时只考虑该分区。
function allocate(shelter, size, accessibleNeed, requestedZoneCode) {
  const zones = requestedZoneCode
    ? shelter.zones.filter((zone) => zone.code === requestedZoneCode)
    : shelter.zones;
  if (requestedZoneCode && zones.length === 0) {
    throw new ServiceError(404, "ZONE_NOT_FOUND", `分区 ${requestedZoneCode} 不存在`, {
      shelterId: shelter.id,
      requestedZoneCode,
    });
  }
  for (const zone of zones) {
    const bedIds = pickBedsInZone(zone, size, accessibleNeed);
    if (bedIds) return { zoneCode: zone.code, bedIds };
  }
  return null;
}

export class CapacityService {
  constructor(store, { now = () => new Date() } = {}) {
    this.store = store;
    this.now = now;
    this.#tail = Promise.resolve();
  }

  #tail;

  // 所有写操作串行化；事件在临界区内落盘，杜绝并发超卖。
  #mutate(fn) {
    const run = this.#tail.then(() => fn());
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #state() {
    return this.store.state;
  }

  #worker(workerId) {
    const id = requireNonEmptyString(workerId, "workerId");
    const worker = this.#state().workers[id];
    if (!worker) throw new ServiceError(401, "UNAUTHENTICATED", "工作人员身份不存在或未登记");
    return worker;
  }

  #shelter(shelterId) {
    requireNonEmptyString(shelterId, "shelterId");
    const shelter = this.#state().shelters[shelterId];
    if (!shelter) throw new ServiceError(404, "SHELTER_NOT_FOUND", `避难所 ${shelterId} 不存在`);
    return shelter;
  }

  #assertJurisdiction(worker, shelter) {
    if (worker.role === "COMMANDER") return;
    if (!worker.districts.includes(shelter.district)) {
      throw new ServiceError(403, "OUTSIDE_JURISDICTION", "工作人员只能处理所属辖区的避难所", {
        workerDistricts: worker.districts,
        shelterDistrict: shelter.district,
      });
    }
  }

  #assertOpen(shelter) {
    const stamp = this.now();
    const minutes = stamp.getHours() * 60 + stamp.getMinutes();
    const [oh, om] = shelter.openHours.opens.split(":").map(Number);
    const [ch, cm] = shelter.openHours.closes.split(":").map(Number);
    const opens = oh * 60 + om;
    const closes = ch * 60 + cm;
    if (minutes < opens || minutes >= closes) {
      throw new ServiceError(409, "SHELTER_CLOSED", "当前不在避难所开放时段内，无法到场核销", {
        now: stamp.toISOString(),
        openHours: shelter.openHours,
      });
    }
  }

  #idempotent(key) {
    if (!key) return null;
    const hit = this.#state().idempotency[key];
    return hit ? { ...hit.result, idempotent: true } : null;
  }

  #assertFreshKey(key, request) {
    if (!key) return;
    const hit = this.#state().idempotency[key];
    if (hit && JSON.stringify(hit.request) !== JSON.stringify(request)) {
      throw new ServiceError(409, "IDEMPOTENCY_CONFLICT", "同一幂等键对应不同的登记请求");
    }
  }

  // ---- 基础数据管理 -------------------------------------------------------

  // 自举：系统尚无任何工作人员时，登记首位指挥员，之后只能由指挥员登记人员。
  bootstrapCommander(input) {
    return this.#mutate(() => {
      if (Object.keys(this.#state().workers).length > 0) {
        throw new ServiceError(409, "ALREADY_INITIALIZED", "系统已有指挥员，请由现有指挥员登记人员");
      }
      const worker = {
        id: requireNonEmptyString(input.workerId, "workerId"),
        name: requireNonEmptyString(input.name, "name"),
        role: "COMMANDER",
        districts: [],
      };
      this.store.commit({ type: "worker-registered", worker });
      return worker;
    });
  }

  registerWorker(actorId, input) {
    return this.#mutate(() => {
      const actor = this.#worker(actorId);
      if (actor.role !== "COMMANDER") {
        throw new ServiceError(403, "FORBIDDEN", "只有指挥员可以登记工作人员");
      }
      const workerId = requireNonEmptyString(input.workerId, "workerId");
      const name = requireNonEmptyString(input.name, "name");
      const role = input.role;
      if (!["STAFF", "COMMANDER"].includes(role)) {
        throw new ServiceError(400, "INVALID_REQUEST", "角色必须是 STAFF 或 COMMANDER");
      }
      const districts = input.districts;
      if (!Array.isArray(districts) || districts.some((d) => typeof d !== "string" || !d.trim())) {
        throw new ServiceError(400, "INVALID_REQUEST", "districts 必须是非空字符串数组");
      }
      if (this.#state().workers[workerId]) {
        throw new ServiceError(409, "WORKER_EXISTS", `工作人员 ${workerId} 已登记`);
      }
      const worker = { id: workerId, name, role, districts: [...new Set(districts.map((d) => d.trim()))] };
      this.store.commit({ type: "worker-registered", worker });
      return worker;
    });
  }

  createShelter(actorId, input) {
    return this.#mutate(() => {
      const actor = this.#worker(actorId);
      if (actor.role !== "COMMANDER") {
        throw new ServiceError(403, "FORBIDDEN", "只有指挥员可以创建避难所");
      }
      const id = requireNonEmptyString(input.id, "id");
      const name = requireNonEmptyString(input.name, "name");
      const district = requireNonEmptyString(input.district, "district");
      const { opens, closes } = input.openHours ?? {};
      const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
      if (!timePattern.test(opens ?? "") || !timePattern.test(closes ?? "") || opens >= closes) {
        throw new ServiceError(400, "INVALID_REQUEST", "openHours 需要合法的 opens/closes（HH:MM，且 opens 早于 closes）");
      }
      if (!Array.isArray(input.zones) || input.zones.length === 0) {
        throw new ServiceError(400, "INVALID_REQUEST", "避难所至少需要一个分区");
      }
      const codes = new Set();
      const zones = input.zones.map((zone) => {
        const code = requireNonEmptyString(zone.code, "zone.code");
        if (codes.has(code)) throw new ServiceError(400, "INVALID_REQUEST", `分区编号重复：${code}`);
        codes.add(code);
        const capacity = requirePositiveInt(zone.capacity, "zone.capacity", 100_000);
        const accessibleCapacity = zone.accessibleCapacity ?? 0;
        if (!Number.isInteger(accessibleCapacity) || accessibleCapacity < 0 || accessibleCapacity > capacity) {
          throw new ServiceError(400, "INVALID_REQUEST", "无障碍床位数必须是 0 到分区容量之间的整数");
        }
        return { code, capacity, accessibleCapacity };
      });
      if (this.#state().shelters[id]) {
        throw new ServiceError(409, "SHELTER_EXISTS", `避难所 ${id} 已存在`);
      }
      const shelter = { id, name, district, openHours: { opens, closes }, zones };
      this.store.commit({ type: "shelter-created", shelter });
      return this.getShelterView(id);
    });
  }

  // ---- 家庭登记：整体成功或有序等待 ---------------------------------------

  apply(input) {
    return this.#mutate(() => {
      const worker = this.#worker(input.workerId);
      const shelter = this.#shelter(input.shelterId);
      this.#assertJurisdiction(worker, shelter);
      const householdId = requireNonEmptyString(input.householdId, "householdId");
      const size = requirePositiveInt(input.size, "size", 200);
      const accessibleNeed = input.accessibleNeed ?? 0;
      if (!Number.isInteger(accessibleNeed) || accessibleNeed < 0 || accessibleNeed > size) {
        throw new ServiceError(400, "INVALID_REQUEST", "无障碍需求人数必须是 0 到家庭人数之间的整数");
      }
      const reason = requireReason(input.reason);
      const key = input.idempotencyKey?.toString() || null;
      const request = { householdId, shelterId: shelter.id, size, accessibleNeed, preferredZoneCode: input.preferredZoneCode ?? null };
      this.#assertFreshKey(key, request);
      const cached = this.#idempotent(key);
      if (cached) return cached;

      const active = this.#state().households[householdId];
      if (active) {
        throw new ServiceError(409, "HOUSEHOLD_ALREADY_ACTIVE", "该家庭已有进行中的预约或候补，请勿重复登记", {
          existing: active,
        });
      }

      const allocation = allocate(shelter, size, accessibleNeed, input.preferredZoneCode ?? null);
      const base = {
        workerId: worker.id,
        reason,
        idempotencyKey: key,
        request,
      };

      if (allocation) {
        const reservationId = `rsv_${randomUUID()}`;
        const result = {
          outcome: "RESERVED",
          reservationId,
          householdId,
          shelterId: shelter.id,
          zoneCode: allocation.zoneCode,
          bedIds: allocation.bedIds,
          size,
          accessibleNeed,
        };
        this.store.commit({
          type: "application-accepted",
          ...base,
          at: this.now().toISOString(),
          reservationId,
          bedIds: allocation.bedIds,
          zoneCode: allocation.zoneCode,
          householdId,
          shelterId: shelter.id,
          size,
          accessibleNeed,
          result,
        });
        return result;
      }

      const entryId = `wl_${randomUUID()}`;
      const result = {
        outcome: "WAITING",
        entryId,
        householdId,
        shelterId: shelter.id,
        requestedZoneCode: input.preferredZoneCode ?? null,
        position: shelter.queue.length + 1,
        size,
        accessibleNeed,
      };
      this.store.commit({
        type: "waitlist-joined",
        ...base,
        at: this.now().toISOString(),
        entryId,
        householdId,
        shelterId: shelter.id,
        size,
        accessibleNeed,
        requestedZoneCode: input.preferredZoneCode ?? null,
        result,
      });
      return result;
    });
  }

  // 床位释放后按候补次序递补：跳过暂放不下的家庭，被跳过者保留原位次。
  #promoteQueue(shelter, reason) {
    const promotions = [];
    for (const entryId of [...shelter.queue]) {
      const entry = this.#state().waitlist[entryId];
      if (!entry || entry.status !== "WAITING") continue;
      const allocation = allocate(
        this.#state().shelters[shelter.id],
        entry.size,
        entry.accessibleNeed,
        entry.requestedZoneCode,
      );
      if (!allocation) continue;
      const reservationId = `rsv_${randomUUID()}`;
      this.store.commit({
        type: "waitlist-promoted",
        at: this.now().toISOString(),
        entryId: entry.id,
        reservationId,
        householdId: entry.householdId,
        shelterId: shelter.id,
        zoneCode: allocation.zoneCode,
        bedIds: allocation.bedIds,
        size: entry.size,
        accessibleNeed: entry.accessibleNeed,
        reason,
        workerId: null,
      });
      promotions.push({
        entryId: entry.id,
        householdId: entry.householdId,
        reservationId,
        zoneCode: allocation.zoneCode,
        bedIds: allocation.bedIds,
      });
    }
    return promotions;
  }

  // ---- 改派：先验证目标可容纳，再原子地释放旧床、锁定新床 ------------------

  reassign(input) {
    return this.#mutate(() => {
      const worker = this.#worker(input.workerId);
      const reservation = this.#activeReservation(input.reservationId);
      const fromShelter = this.#shelter(reservation.shelterId);
      this.#assertJurisdiction(worker, fromShelter);
      const toShelter = this.#shelter(input.targetShelterId);
      const reason = requireReason(input.reason);

      // 跨辖区改派必须有指挥员身份或授权凭证；否则无权触碰目标站点。
      const crossDistrict = fromShelter.district !== toShelter.district;
      const authorization = typeof input.authorization === "string" ? input.authorization.trim() : "";
      const authorized = worker.role === "COMMANDER" || (crossDistrict && authorization !== "");
      if (!authorized) {
        if (crossDistrict) {
          throw new ServiceError(403, "CROSS_DISTRICT_UNAUTHORIZED", "跨辖区改派需要指挥员身份或授权凭证", {
            fromDistrict: fromShelter.district,
            toDistrict: toShelter.district,
          });
        }
        this.#assertJurisdiction(worker, toShelter);
      }
      if (reservation.status === "CHECKED_IN") {
        throw new ServiceError(409, "ALREADY_CHECKED_IN", "家庭已到场核销，不能改派");
      }

      const targetZoneCode = input.targetZoneCode ?? null;
      if (toShelter.id === fromShelter.id && targetZoneCode === reservation.zoneCode) {
        throw new ServiceError(409, "SAME_DESTINATION", "改派目的地与当前安置位置相同");
      }
      const allocation = allocate(toShelter, reservation.size, reservation.accessibleNeed, targetZoneCode);
      if (!allocation) {
        throw new ServiceError(409, "INSUFFICIENT_CAPACITY", "目标分区无法整户容纳该家庭", {
          targetShelterId: toShelter.id,
        });
      }

      const key = input.idempotencyKey?.toString() || null;
      const request = {
        reservationId: reservation.id,
        targetShelterId: toShelter.id,
        targetZoneCode,
      };
      this.#assertFreshKey(key, request);
      const cached = this.#idempotent(key);
      if (cached) return cached;

      const newReservationId = `rsv_${randomUUID()}`;
      const result = {
        outcome: "REASSIGNED",
        oldReservationId: reservation.id,
        newReservationId,
        householdId: reservation.householdId,
        fromShelterId: fromShelter.id,
        fromZoneCode: reservation.zoneCode,
        toShelterId: toShelter.id,
        toZoneCode: allocation.zoneCode,
        bedIds: allocation.bedIds,
      };
      this.store.commit({
        type: "reservation-reassigned",
        at: this.now().toISOString(),
        workerId: worker.id,
        reason,
        authorization: crossDistrict ? authorization || "COMMANDER" : null,
        idempotencyKey: key,
        request,
        result,
        oldReservationId: reservation.id,
        newReservationId,
        householdId: reservation.householdId,
        fromShelterId: fromShelter.id,
        fromZoneCode: reservation.zoneCode,
        toShelterId: toShelter.id,
        toZoneCode: allocation.zoneCode,
        size: reservation.size,
        accessibleNeed: reservation.accessibleNeed,
        releasedBedIds: reservation.bedIds,
        lockedBedIds: allocation.bedIds,
      });

      const promotions = this.#promoteQueue(fromShelter, "改派释放床位后自动递补");
      return { ...result, promotions };
    });
  }

  #activeReservation(reservationId) {
    requireNonEmptyString(reservationId, "reservationId");
    const reservation = this.#state().reservations[reservationId];
    if (!reservation) throw new ServiceError(404, "RESERVATION_NOT_FOUND", "预约不存在");
    if (reservation.status === "CANCELLED" || reservation.status === "REASSIGNED") {
      throw new ServiceError(409, "RESERVATION_INACTIVE", `预约已${reservation.status === "CANCELLED" ? "取消" : "改派"}`);
    }
    return reservation;
  }

  // ---- 取消 ---------------------------------------------------------------

  cancelReservation(input) {
    return this.#mutate(() => {
      const worker = this.#worker(input.workerId);
      const reservation = this.#activeReservation(input.reservationId);
      const shelter = this.#shelter(reservation.shelterId);
      this.#assertJurisdiction(worker, shelter);
      if (reservation.status === "CHECKED_IN") {
        throw new ServiceError(409, "ALREADY_CHECKED_IN", "家庭已到场核销，不能取消预约");
      }
      const reason = requireReason(input.reason);

      this.store.commit({
        type: "reservation-cancelled",
        at: this.now().toISOString(),
        workerId: worker.id,
        reason,
        reservationId: reservation.id,
        shelterId: shelter.id,
        householdId: reservation.householdId,
        bedIds: reservation.bedIds,
      });
      const promotions = this.#promoteQueue(shelter, "取消释放床位后自动递补");
      return {
        outcome: "CANCELLED",
        reservationId: reservation.id,
        householdId: reservation.householdId,
        releasedBedIds: reservation.bedIds,
        promotions,
      };
    });
  }

  cancelWaitlist(input) {
    return this.#mutate(() => {
      const worker = this.#worker(input.workerId);
      requireNonEmptyString(input.entryId, "entryId");
      const entry = this.#state().waitlist[input.entryId];
      if (!entry) throw new ServiceError(404, "WAITLIST_ENTRY_NOT_FOUND", "候补记录不存在");
      const shelter = this.#shelter(entry.shelterId);
      this.#assertJurisdiction(worker, shelter);
      if (entry.status !== "WAITING") {
        throw new ServiceError(409, "WAITLIST_ENTRY_INACTIVE", `候补记录当前状态为 ${entry.status}`);
      }
      const reason = requireReason(input.reason);
      this.store.commit({
        type: "waitlist-entry-cancelled",
        at: this.now().toISOString(),
        workerId: worker.id,
        reason,
        entryId: entry.id,
        shelterId: shelter.id,
        householdId: entry.householdId,
      });
      return { outcome: "CANCELLED", entryId: entry.id, householdId: entry.householdId };
    });
  }

  // ---- 到场核销 -----------------------------------------------------------

  checkIn(input) {
    return this.#mutate(() => {
      const worker = this.#worker(input.workerId);
      const reservation = this.#activeReservation(input.reservationId);
      const shelter = this.#shelter(reservation.shelterId);
      this.#assertJurisdiction(worker, shelter);
      this.#assertOpen(shelter);
      if (reservation.status === "CHECKED_IN") {
        throw new ServiceError(409, "ALREADY_CHECKED_IN", "该家庭已完成到场核销");
      }
      const reason = requireReason(input.reason);
      this.store.commit({
        type: "reservation-checked-in",
        at: this.now().toISOString(),
        workerId: worker.id,
        reason,
        reservationId: reservation.id,
        shelterId: shelter.id,
        householdId: reservation.householdId,
      });
      return {
        outcome: "CHECKED_IN",
        reservationId: reservation.id,
        householdId: reservation.householdId,
        shelterId: shelter.id,
        checkedInAt: this.now().toISOString(),
      };
    });
  }

  // ---- 查询 ---------------------------------------------------------------

  getShelterView(shelterId) {
    const shelter = this.#shelter(shelterId);
    const zones = shelter.zones.map((zone) => {
      const occupiedBeds = zone.beds.filter((bed) => bed.reservationId !== null);
      const occupied = occupiedBeds.length;
      const occupiedAccessible = occupiedBeds.filter((bed) => bed.accessible).length;
      return {
        code: zone.code,
        capacity: zone.capacity,
        accessibleCapacity: zone.accessibleCapacity,
        occupied,
        occupiedAccessible,
        available: zone.capacity - occupied,
        availableAccessible: zone.accessibleCapacity - occupiedAccessible,
      };
    });
    const queue = shelter.queue.map((entryId, index) => {
      const entry = this.#state().waitlist[entryId];
      return {
        position: index + 1,
        entryId: entry.id,
        householdId: entry.householdId,
        size: entry.size,
        accessibleNeed: entry.accessibleNeed,
        requestedZoneCode: entry.requestedZoneCode,
        status: entry.status,
        joinedAt: entry.joinedAt,
        updatedAt: entry.updatedAt,
        lastReason: entry.lastReason,
      };
    });
    const totals = zones.reduce(
      (acc, zone) => {
        acc.capacity += zone.capacity;
        acc.accessibleCapacity += zone.accessibleCapacity;
        acc.occupied += zone.occupied;
        acc.occupiedAccessible += zone.occupiedAccessible;
        return acc;
      },
      { capacity: 0, accessibleCapacity: 0, occupied: 0, occupiedAccessible: 0 },
    );
    return {
      id: shelter.id,
      name: shelter.name,
      district: shelter.district,
      openHours: shelter.openHours,
      totals: { ...totals, available: totals.capacity - totals.occupied, availableAccessible: totals.accessibleCapacity - totals.occupiedAccessible },
      zones,
      queue,
    };
  }

  async queryShelter(workerId, shelterId) {
    const worker = this.#worker(workerId);
    const shelter = this.#shelter(shelterId);
    this.#assertJurisdiction(worker, shelter);
    return this.getShelterView(shelterId);
  }

  async listShelters(workerId) {
    const worker = this.#worker(workerId);
    return Object.values(this.#state().shelters)
      .filter((shelter) => worker.role === "COMMANDER" || worker.districts.includes(shelter.district))
      .map((shelter) => {
        const view = this.getShelterView(shelter.id);
        return {
          id: view.id,
          name: view.name,
          district: view.district,
          openHours: view.openHours,
          totals: view.totals,
          waiting: view.queue.length,
        };
      });
  }

  async getHousehold(workerId, householdId) {
    const worker = this.#worker(workerId);
    requireNonEmptyString(householdId, "householdId");
    const pointer = this.#state().households[householdId];
    if (!pointer) throw new ServiceError(404, "HOUSEHOLD_NOT_FOUND", "该家庭没有进行中的预约或候补");
    const shelter = this.#shelter(pointer.shelterId);
    this.#assertJurisdiction(worker, shelter);
    if (pointer.kind === "reservation") {
      const reservation = this.#state().reservations[pointer.refId];
      return { householdId, kind: "reservation", reservation: this.#reservationView(reservation) };
    }
    const entry = this.#state().waitlist[pointer.refId];
    const position = shelter.queue.indexOf(entry.id) + 1;
    return { householdId, kind: "waitlist", entry: { ...this.#entryView(entry), position: position > 0 ? position : null } };
  }

  #reservationView(reservation) {
    return {
      reservationId: reservation.id,
      shelterId: reservation.shelterId,
      zoneCode: reservation.zoneCode,
      householdId: reservation.householdId,
      size: reservation.size,
      accessibleNeed: reservation.accessibleNeed,
      bedIds: reservation.bedIds,
      status: reservation.status,
      createdAt: reservation.createdAt,
      updatedAt: reservation.updatedAt,
      lastReason: reservation.lastReason,
      reassignedFrom: reservation.reassignedFrom ?? null,
      promotedFrom: reservation.promotedFrom ?? null,
      history: reservation.history,
    };
  }

  #entryView(entry) {
    return {
      entryId: entry.id,
      shelterId: entry.shelterId,
      householdId: entry.householdId,
      size: entry.size,
      accessibleNeed: entry.accessibleNeed,
      requestedZoneCode: entry.requestedZoneCode,
      status: entry.status,
      joinedAt: entry.joinedAt,
      updatedAt: entry.updatedAt,
      lastReason: entry.lastReason,
      history: entry.history,
    };
  }

  // 床位审计：沿事件日志解释每张床为何被锁定或释放。
  async bedAudit(workerId, shelterId, bedId) {
    const worker = this.#worker(workerId);
    const shelter = this.#shelter(shelterId);
    this.#assertJurisdiction(worker, shelter);

    const knownBeds = new Set(shelter.zones.flatMap((zone) => zone.beds.map((bed) => bed.id)));
    if (bedId != null && !knownBeds.has(bedId)) {
      throw new ServiceError(404, "BED_NOT_FOUND", `床位 ${bedId} 不属于该避难所`);
    }

    const bedZone = new Map();
    for (const zone of shelter.zones) {
      for (const bed of zone.beds) bedZone.set(bed.id, zone.code);
    }

    const timeline = [];
    for (const event of this.store.events()) {
      const touches = (ids) => (bedId ? ids?.includes(bedId) : true);
      let record = null;
      if (event.type === "application-accepted" && event.shelterId === shelter.id && touches(event.bedIds)) {
        record = {
          action: "LOCKED",
          via: "登记",
          reservationId: event.reservationId,
          householdId: event.householdId,
          zoneCode: event.zoneCode,
          bedIds: bedId ? [bedId] : event.bedIds,
        };
      } else if (event.type === "reservation-cancelled" && event.shelterId === shelter.id && touches(event.bedIds)) {
        record = {
          action: "RELEASED",
          via: "取消",
          reservationId: event.reservationId,
          householdId: event.householdId,
          zoneCode: bedId ? bedZone.get(bedId) : null,
          bedIds: bedId ? [bedId] : event.bedIds,
        };
      } else if (event.type === "waitlist-promoted" && event.shelterId === shelter.id && touches(event.bedIds)) {
        record = {
          action: "LOCKED",
          via: "候补递补",
          reservationId: event.reservationId,
          householdId: event.householdId,
          entryId: event.entryId,
          zoneCode: event.zoneCode,
          bedIds: bedId ? [bedId] : event.bedIds,
        };
      } else if (event.type === "reservation-reassigned") {
        if (event.fromShelterId === shelter.id && touches(event.releasedBedIds)) {
          record = {
            action: "RELEASED",
            via: "改派迁出",
            reservationId: event.oldReservationId,
            householdId: event.householdId,
            zoneCode: event.fromZoneCode,
            counterpartShelterId: event.toShelterId,
            bedIds: bedId ? [bedId] : event.releasedBedIds,
          };
        } else if (event.toShelterId === shelter.id && touches(event.lockedBedIds)) {
          record = {
            action: "LOCKED",
            via: "改派迁入",
            reservationId: event.newReservationId,
            householdId: event.householdId,
            zoneCode: event.toZoneCode,
            counterpartShelterId: event.fromShelterId,
            bedIds: bedId ? [bedId] : event.lockedBedIds,
          };
        }
      }
      if (record) {
        timeline.push({
          seq: event.seq,
          at: event.at,
          ...record,
          reason: event.reason,
          workerId: event.workerId,
          authorization: event.authorization ?? null,
        });
      }
    }
    return { shelterId: shelter.id, bedId: bedId ?? null, timeline };
  }
}
