import { createHash, randomUUID } from "node:crypto";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "./errors.js";

const ACTIVE_STATUSES = new Set(["confirmed", "waiting", "checked_in"]);
const OCCUPYING_STATUSES = new Set(["confirmed", "checked_in"]);

const isInt = (value) => Number.isInteger(value);
const nowIso = (ms) => new Date(ms).toISOString();

function requireString(value, field, { min = 1, max = 200 } = {}) {
  if (typeof value !== "string" || value.trim().length < min) {
    throw badRequest(`字段 ${field} 必须是长度 ${min}-${max} 的字符串`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) throw badRequest(`字段 ${field} 最长 ${max} 个字符`);
  return trimmed;
}

function requireNonNegInt(value, field) {
  if (!isInt(value) || value < 0) throw badRequest(`字段 ${field} 必须是非负整数`);
  return value;
}

export function createService(store) {
  const state = () => store.state;

  // ---------- 读取辅助 ----------

  function getSite(siteId) {
    const site = state().sites.get(siteId);
    if (!site) throw notFound(`避难所 ${siteId} 不存在`);
    return site;
  }

  function getReservation(reservationId) {
    const reservation = state().reservations.get(reservationId);
    if (!reservation) throw notFound(`预约 ${reservationId} 不存在`);
    return reservation;
  }

  function authenticate(token) {
    if (!token) throw unauthorized();
    const staff = state().staff.get(token.staffId);
    if (!staff || !staff.active || staff.token !== token.value) throw unauthorized();
    return staff;
  }

  /** 普通工作人员只能操作所属辖区；指挥员可跨辖区。 */
  function assertSiteJurisdiction(staff, site, action = "操作") {
    if (staff.role !== "coordinator" && staff.district !== site.district) {
      throw forbidden(`工作人员 ${staff.name} 不属于辖区 ${site.district}，无权${action}该站点`);
    }
  }

  /**
   * 改派授权：跨辖区改派只能由指挥员执行；
   * 普通工作人员仅可在本辖区内调整。
   */
  function assertReassignAuthorized(staff, fromSite, toSite) {
    if (staff.role === "coordinator") return;
    if (staff.district !== fromSite.district || staff.district !== toSite.district) {
      throw forbidden(
        `从辖区 ${fromSite.district} 改派至 ${toSite.district} 属于跨区挪用，须指挥员授权`,
      );
    }
  }

  function assertOpen(site) {
    const windows = site.openWindows ?? [];
    if (windows.length === 0) return; // 未配置时段视为全天开放
    const at = store.now();
    const open = windows.some(({ from, to }) => at >= from && at <= to);
    if (!open) throw conflict("SITE_CLOSED", `避难所 ${site.name} 当前不在开放时段内`);
  }

  function zoneOccupancy(siteId, zoneId) {
    let generalUsed = 0;
    let accessibleUsed = 0;
    for (const reservation of state().reservations.values()) {
      if (
        reservation.siteId === siteId &&
        reservation.zoneId === zoneId &&
        OCCUPYING_STATUSES.has(reservation.status)
      ) {
        generalUsed += reservation.household.members - reservation.household.accessibleNeeded;
        accessibleUsed += reservation.household.accessibleNeeded;
      }
    }
    return { generalUsed, accessibleUsed };
  }

  function occupancyCounters(siteId) {
    const counters = new Map();
    for (const zone of state().sites.get(siteId).zones.values()) {
      counters.set(zone.id, { generalUsed: 0, accessibleUsed: 0 });
    }
    for (const reservation of state().reservations.values()) {
      if (
        reservation.siteId === siteId &&
        OCCUPYING_STATUSES.has(reservation.status) &&
        counters.has(reservation.zoneId)
      ) {
        const counter = counters.get(reservation.zoneId);
        counter.generalUsed += reservation.household.members - reservation.household.accessibleNeeded;
        counter.accessibleUsed += reservation.household.accessibleNeeded;
      }
    }
    return counters;
  }

  function zoneFitsWith(site, counters, zoneId, generalNeeded, accessibleNeeded) {
    const zone = site.zones.get(zoneId);
    const used = counters.get(zoneId);
    // 两类床位各自独立核算：普通需求不能挤占无障碍床位。
    return (
      zone.capacity - zone.accessibleBeds - used.generalUsed >= generalNeeded &&
      zone.accessibleBeds - used.accessibleUsed >= accessibleNeeded
    );
  }

  /** 基于传入的占用计数寻找分区；不触碰全局状态。 */
  function findZoneWith(site, counters, generalNeeded, accessibleNeeded, preferredZoneId) {
    if (preferredZoneId) {
      if (!site.zones.has(preferredZoneId)) return null;
      return zoneFitsWith(site, counters, preferredZoneId, generalNeeded, accessibleNeeded)
        ? preferredZoneId
        : null;
    }
    for (const zoneId of site.zones.keys()) {
      if (zoneFitsWith(site, counters, zoneId, generalNeeded, accessibleNeeded)) return zoneId;
    }
    return null;
  }

  function consume(counters, zoneId, generalNeeded, accessibleNeeded) {
    const counter = counters.get(zoneId);
    counter.generalUsed += generalNeeded;
    counter.accessibleUsed += accessibleNeeded;
  }

  /**
   * 容量释放后的有序递补（纯模拟，不改全局状态）：
   * 严格 FIFO——从队首开始，第一个放不下的家庭会阻塞队列，
   * 后面的家庭不能越过它先拿床。
   */
  function buildPromotions(site, counters, queueIds, actor) {
    const s = state();
    const events = [];
    for (const reservationId of queueIds) {
      const reservation = s.reservations.get(reservationId);
      const { members, accessibleNeeded } = reservation.household;
      const zoneId = findZoneWith(
        site,
        counters,
        members - accessibleNeeded,
        accessibleNeeded,
        reservation.zonePreference,
      );
      if (zoneId === null) break;
      consume(counters, zoneId, members - accessibleNeeded, accessibleNeeded);
      events.push({
        type: "PROMOTED",
        data: {
          reservationId,
          siteId: site.id,
          zoneId,
          reason: "容量释放后按等待次序自动递补",
        },
        actor: actor ?? { kind: "system" },
      });
    }
    return events;
  }

  // ---------- 管理：站点与工作人员 ----------

  async function registerSite(input) {
    const name = requireString(input?.name, "name");
    const district = requireString(input?.district, "district");
    if (!Array.isArray(input.zones) || input.zones.length === 0) {
      throw badRequest("zones 必须至少包含一个分区");
    }
    const zones = [];
    const zoneIds = new Set();
    for (const zone of input.zones) {
      const id = zone.id != null ? requireString(zone.id, "zones[].id") : `Z-${randomUUID()}`;
      if (zoneIds.has(id)) throw badRequest(`分区标识 ${id} 重复`);
      zoneIds.add(id);
      const capacity = requireNonNegInt(zone.capacity, "zones[].capacity");
      const accessibleBeds = requireNonNegInt(zone.accessibleBeds, "zones[].accessibleBeds");
      if (accessibleBeds > capacity) {
        throw badRequest("无障碍床位数不能大于分区总容量");
      }
      zones.push({ id, name: requireString(zone.name, "zones[].name"), capacity, accessibleBeds });
    }
    const openWindows = validateWindows(input.openWindows);
    const id = input.id != null ? requireString(input.id, "id") : `S-${randomUUID()}`;

    return store.mutate((s) => {
      if (s.sites.has(id)) throw conflict("SITE_EXISTS", `避难所 ${id} 已存在`);
      const site = {
        id,
        name,
        district,
        zones,
        openWindows,
        createdAt: store.now(),
      };
      return {
        events: [{ type: "SITE_REGISTERED", data: { site }, actor: { kind: "system" } }],
        result: site,
      };
    });
  }

  function validateWindows(windows) {
    if (windows == null) return [];
    if (!Array.isArray(windows)) throw badRequest("openWindows 必须是数组");
    return windows.map((window) => {
      if (!isInt(window.from) || !isInt(window.to) || window.to <= window.from) {
        throw badRequest("开放时段需包含有效的毫秒时间戳 from 与 to，且 to 晚于 from");
      }
      return { from: window.from, to: window.to };
    });
  }

  async function registerStaff(input) {
    const name = requireString(input?.name, "name");
    const district = requireString(input?.district, "district");
    const role = input.role === "coordinator" ? "coordinator" : "worker";
    const id = input.id != null ? requireString(input.id, "id") : `W-${randomUUID()}`;
    const token = randomUUID();

    const staff = await store.mutate((s) => {
      if (s.staff.has(id)) throw conflict("STAFF_EXISTS", `工作人员 ${id} 已存在`);
      const record = { id, name, district, role, token, active: true, createdAt: store.now() };
      return {
        events: [{ type: "STAFF_REGISTERED", data: { staff: record }, actor: { kind: "system" } }],
        result: record,
      };
    });
    // 令牌只在创建时完整返回一次；事件日志保留它供重启后鉴权。
    return { id, name, district, role, token };
  }

  // ---------- 登记 ----------

  function payloadHash(payload) {
    return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  }

  function normalizeHousehold(input, siteId) {
    const h = input?.household ?? input; // 也接受把家庭字段平铺在顶层
    const name = requireString(h.name, "household.name");
    const members = requireNonNegInt(h.members, "household.members");
    if (members < 1) throw badRequest("家庭人数至少为 1");
    const accessibleNeeded = requireNonNegInt(h.accessibleNeeded ?? 0, "household.accessibleNeeded");
    if (accessibleNeeded > members) {
      throw badRequest("需要无障碍床位的人数不能超过家庭总人数");
    }
    return {
      id: h.id != null ? requireString(h.id, "household.id") : `H-${randomUUID()}`,
      name,
      members,
      accessibleNeeded,
      contact: typeof h.contact === "string" ? h.contact.trim().slice(0, 200) : null,
      registeredSiteId: siteId,
    };
  }

  async function reserve(token, body, idempotencyKey) {
    const staff = authenticate(token);
    const siteId = requireString(body?.siteId, "siteId");
    const site = getSite(siteId);
    assertSiteJurisdiction(staff, site, "登记");
    assertOpen(site);

    const household = normalizeHousehold(body, siteId);
    const preferredZoneId = body.zoneId != null ? requireString(body.zoneId, "zoneId") : null;
    if (preferredZoneId && !site.zones.has(preferredZoneId)) {
      throw badRequest(`站点 ${site.name} 不存在分区 ${preferredZoneId}`);
    }
    const generalNeeded = household.members - household.accessibleNeeded;
    const key = idempotencyKey ? requireString(idempotencyKey, "Idempotency-Key") : null;
    const hashPayload = { siteId, household, zoneId: preferredZoneId };

    return store.mutate((s) => {
      if (key) {
        const seen = s.idempotency.get(`${staff.id}:${key}`);
        if (seen) {
          if (seen.payloadHash !== payloadHash(hashPayload)) {
            throw conflict(
              "IDEMPOTENCY_KEY_REUSED",
              "相同的幂等键对应了不同的登记请求",
            );
          }
          const reservation = s.reservations.get(seen.reservationId);
          return { events: [], result: reservationResponse(s, reservation, true) };
        }
      }

      // 同一家庭在同一站点已有生效登记时拒绝重复占床。
      for (const existing of s.reservations.values()) {
        if (
          existing.household.id === household.id &&
          existing.siteId === siteId &&
          ACTIVE_STATUSES.has(existing.status)
        ) {
          throw conflict(
            "DUPLICATE_ACTIVE_RESERVATION",
            `家庭 ${household.name} 在该站点已有登记（${existing.id}，状态 ${existing.status}）`,
          );
        }
      }

      const actor = actorSnapshot(staff);
      // 已有家庭排队时，新登记一律排到队尾，避免后来者直接占床形成插队。
      let zoneId = null;
      if (s.waiting.get(siteId).length === 0) {
        const counters = occupancyCounters(siteId);
        zoneId = findZoneWith(site, counters, generalNeeded, household.accessibleNeeded, preferredZoneId);
      }
      const reservationId = `R-${randomUUID()}`;
      const reservation = {
        id: reservationId,
        siteId,
        zoneId,
        zonePreference: preferredZoneId,
        household,
        status: zoneId ? "confirmed" : "waiting",
        createdAt: store.now(),
      };
      const events = [];
      if (zoneId) {
        events.push({
          type: "RESERVATION_CONFIRMED",
          data: { reservation: { ...reservation, status: "confirmed" } },
          actor,
        });
      } else {
        const waitReason =
          s.waiting.get(siteId).length > 0
            ? "该站点已有家庭排队，按序等待"
            : preferredZoneId
              ? `指定分区 ${preferredZoneId} 容量不足`
              : "站点各分区容量均不足，进入有序等待";
        events.push({
          type: "WAITLISTED",
          data: { reservation: { ...reservation, status: "waiting" }, reason: waitReason },
          actor,
        });
      }
      if (key) {
        events.push({
          type: "IDEMPOTENCY_RECORDED",
          data: {
            key: `${staff.id}:${key}`,
            payloadHash: payloadHash(hashPayload),
            staffId: staff.id,
            reservationId,
            outcome: reservation.status,
          },
          actor,
        });
      }
      return {
        events,
        result: () => reservationResponse(state(), state().reservations.get(reservationId), false),
      };
    });
  }

  function actorSnapshot(staff) {
    return {
      kind: "staff",
      staffId: staff.id,
      name: staff.name,
      role: staff.role,
      district: staff.district,
    };
  }

  function queuePosition(s, reservation) {
    if (reservation.status !== "waiting") return null;
    const queue = s.waiting.get(reservation.siteId);
    return queue.indexOf(reservation.id) + 1;
  }

  function reservationResponse(s, reservation, replayed) {
    return {
      reservation: publicReservation(reservation),
      status: reservation.status,
      queuePosition: queuePosition(s, reservation),
      replayed: replayed === true,
    };
  }

  function publicReservation(reservation) {
    return {
      id: reservation.id,
      siteId: reservation.siteId,
      zoneId: reservation.zoneId,
      zonePreference: reservation.zonePreference ?? null,
      household: reservation.household,
      status: reservation.status,
      createdAt: nowIso(reservation.createdAt),
    };
  }

  // ---------- 状态变更：取消 / 核销 / 改派 ----------

  async function cancel(token, reservationId, reason) {
    const staff = authenticate(token);
    const checkedReason = requireString(reason, "reason", { max: 500 });
    const reservation = getReservation(reservationId);
    const site = getSite(reservation.siteId);
    assertSiteJurisdiction(staff, site, "取消");
    if (!ACTIVE_STATUSES.has(reservation.status)) {
      throw conflict("RESERVATION_INACTIVE", `预约当前状态为 ${reservation.status}，无法取消`);
    }

    return store.mutate((s) => {
      const current = s.reservations.get(reservationId);
      if (!ACTIVE_STATUSES.has(current.status)) {
        throw conflict("RESERVATION_INACTIVE", `预约当前状态为 ${current.status}，无法取消`);
      }
      const actor = actorSnapshot(staff);
      const events = [
        {
          type: "CANCELLED",
          data: { reservationId, siteId: current.siteId, reason: checkedReason },
          actor,
        },
      ];
      if (OCCUPYING_STATUSES.has(current.status)) {
        // 用模拟计数：先扣除本户释放的床位，再按队列次序递补。
        const site = s.sites.get(current.siteId);
        const counters = occupancyCounters(current.siteId);
        const used = counters.get(current.zoneId);
        used.generalUsed -= current.household.members - current.household.accessibleNeeded;
        used.accessibleUsed -= current.household.accessibleNeeded;
        const queue = s.waiting
          .get(current.siteId)
          .filter((id) => id !== reservationId);
        events.push(...buildPromotions(site, counters, queue, actor));
      }
      return { events, result: { cancelled: reservationId, promotions: countPromotions(events) } };
    });
  }

  async function checkIn(token, reservationId, reason) {
    const staff = authenticate(token);
    const reservation = getReservation(reservationId);
    const site = getSite(reservation.siteId);
    assertSiteJurisdiction(staff, site, "核销");
    assertOpen(site);
    if (reservation.status !== "confirmed") {
      throw conflict(
        "NOT_CONFIRMED",
        `预约当前状态为 ${reservation.status}，仅已确认预约可到场核销`,
      );
    }
    const checkedReason = reason ? requireString(reason, "reason", { max: 500 }) : "到场入住";

    return store.mutate((s) => {
      const current = s.reservations.get(reservationId);
      if (current.status !== "confirmed") {
        throw conflict("NOT_CONFIRMED", `预约当前状态为 ${current.status}，仅已确认预约可到场核销`);
      }
      return {
        events: [
          {
            type: "CHECKED_IN",
            data: { reservationId, siteId: current.siteId, reason: checkedReason },
            actor: actorSnapshot(staff),
          },
        ],
        result: () => reservationResponse(s, s.reservations.get(reservationId), false),
      };
    });
  }

  async function markNoShow(token, reservationId, reason) {
    const staff = authenticate(token);
    const checkedReason = requireString(reason, "reason", { max: 500 });
    const reservation = getReservation(reservationId);
    const site = getSite(reservation.siteId);
    assertSiteJurisdiction(staff, site, "标记失约");
    if (reservation.status !== "confirmed") {
      throw conflict("NOT_CONFIRMED", `预约当前状态为 ${reservation.status}，无法标记失约`);
    }

    return store.mutate((s) => {
      const current = s.reservations.get(reservationId);
      if (current.status !== "confirmed") {
        throw conflict("NOT_CONFIRMED", `预约当前状态为 ${current.status}，无法标记失约`);
      }
      const actor = actorSnapshot(staff);
      const site = s.sites.get(current.siteId);
      const counters = occupancyCounters(current.siteId);
      const used = counters.get(current.zoneId);
      used.generalUsed -= current.household.members - current.household.accessibleNeeded;
      used.accessibleUsed -= current.household.accessibleNeeded;
      const queue = s.waiting.get(current.siteId);
      const events = [
        {
          type: "MARKED_NO_SHOW",
          data: { reservationId, siteId: current.siteId, reason: checkedReason },
          actor,
        },
        ...buildPromotions(site, counters, queue, actor),
      ];
      return {
        events,
        result: () => ({
          reservationId,
          status: "no_show",
          promotions: countPromotions(events),
        }),
      };
    });
  }

  async function reassign(token, reservationId, body) {
    const staff = authenticate(token);
    const reason = requireString(body?.reason, "reason", { max: 500 });
    const toSiteId = requireString(body?.toSiteId, "toSiteId");
    const target = getSite(toSiteId);
    const reservation = getReservation(reservationId);
    const source = getSite(reservation.siteId);
    assertReassignAuthorized(staff, source, target);
    if (!ACTIVE_STATUSES.has(reservation.status)) {
      throw conflict("RESERVATION_INACTIVE", `预约当前状态为 ${reservation.status}，无法改派`);
    }
    if (reservation.status === "checked_in") {
      throw conflict("ALREADY_CHECKED_IN", "已到场核销的家庭须先办理退宿再改派");
    }
    assertOpen(target);

    return store.mutate((s) => {
      const current = s.reservations.get(reservationId);
      if (!ACTIVE_STATUSES.has(current.status)) {
        throw conflict("RESERVATION_INACTIVE", `预约当前状态为 ${current.status}，无法改派`);
      }
      const isWaiting = current.status === "waiting";
      const requestedZone = body.toZoneId != null ? requireString(body.toZoneId, "toZoneId") : null;
      if (requestedZone && !target.zones.has(requestedZone)) {
        throw badRequest(`目标站点 ${target.name} 不存在分区 ${requestedZone}`);
      }

      const { members, accessibleNeeded } = current.household;
      const generalNeeded = members - accessibleNeeded;
      let toZoneId = null;
      let newStatus = current.status;
      if (!isWaiting) {
        // 已确认家庭改派等于直接占目标站点的床；目标站点若有人排队，不得插队。
        if (s.waiting.get(toSiteId).length > 0) {
          throw conflict(
            "TARGET_HAS_QUEUE",
            `目标站点 ${target.name} 已有家庭排队，行政改派不得插队`,
          );
        }
        const targetCounters = occupancyCounters(toSiteId);
        toZoneId = findZoneWith(target, targetCounters, generalNeeded, accessibleNeeded, requestedZone);
        if (toZoneId === null) {
          throw conflict(
            "TARGET_AT_CAPACITY",
            `目标站点 ${target.name} 无法整体容纳该家庭，改派会造成超卖`,
          );
        }
      } else if (s.waiting.get(toSiteId).length === 0) {
        // 等待家庭改派：目标站点无人排队且有空床时直接确认，否则排到目标队尾。
        const targetCounters = occupancyCounters(toSiteId);
        toZoneId = findZoneWith(target, targetCounters, generalNeeded, accessibleNeeded, requestedZone);
        newStatus = toZoneId ? "confirmed" : "waiting";
      }
      // 等待家庭的分区偏好在目标站点也存在时才保留，否则清空，避免永远无法递补。
      const preference = isWaiting
        ? toZoneId
          ? null
          : requestedZone ?? (target.zones.has(current.zonePreference) ? current.zonePreference : null)
        : null;

      const actor = actorSnapshot(staff);
      const events = [
        {
          type: "REASSIGNED",
          data: {
            reservationId,
            fromSiteId: current.siteId,
            fromZoneId: current.zoneId,
            toSiteId,
            toZoneId,
            zonePreference: preference,
            newStatus,
            reason,
          },
          actor,
        },
      ];
      if (!isWaiting) {
        // 模拟改派后的占用，再为释放出的容量办理递补（同站点改派时新分区仍计入占用）。
        const source = s.sites.get(current.siteId);
        const counters = occupancyCounters(current.siteId);
        const oldUsed = counters.get(current.zoneId);
        oldUsed.generalUsed -= generalNeeded;
        oldUsed.accessibleUsed -= accessibleNeeded;
        if (current.siteId === toSiteId) {
          consume(counters, toZoneId, generalNeeded, accessibleNeeded);
        }
        events.push(...buildPromotions(source, counters, s.waiting.get(current.siteId), actor));
      }
      return {
        events,
        result: () => reservationResponse(s, s.reservations.get(reservationId), false),
      };
    });
  }

  function countPromotions(events) {
    return events.filter((event) => event.type === "PROMOTED").length;
  }

  // ---------- 查询 ----------

  function siteView(siteId) {
    const site = getSite(siteId);
    const at = store.now();
    const zones = [...site.zones.values()].map((zone) => {
      const { generalUsed, accessibleUsed } = zoneOccupancy(site.id, zone.id);
      return {
        id: zone.id,
        name: zone.name,
        capacity: zone.capacity,
        accessibleBeds: zone.accessibleBeds,
        generalBeds: zone.capacity - zone.accessibleBeds,
        occupied: {
          general: generalUsed,
          accessible: accessibleUsed,
          total: generalUsed + accessibleUsed,
        },
        available: {
          general: zone.capacity - zone.accessibleBeds - generalUsed,
          accessible: zone.accessibleBeds - accessibleUsed,
          total: zone.capacity - generalUsed - accessibleUsed,
        },
      };
    });
    const totals = zones.reduce(
      (acc, zone) => {
        acc.capacity += zone.capacity;
        acc.accessibleBeds += zone.accessibleBeds;
        acc.occupiedGeneral += zone.occupied.general;
        acc.occupiedAccessible += zone.occupied.accessible;
        return acc;
      },
      { capacity: 0, accessibleBeds: 0, occupiedGeneral: 0, occupiedAccessible: 0 },
    );
    const queue = state().waiting.get(siteId).map((reservationId, index) => {
      const r = state().reservations.get(reservationId);
      return {
        position: index + 1,
        reservationId: r.id,
        zonePreference: r.zonePreference ?? null,
        household: { id: r.household.id, name: r.household.name, members: r.household.members, accessibleNeeded: r.household.accessibleNeeded },
        status: r.status,
        since: nowIso(r.createdAt),
      };
    });
    const active = [...state().reservations.values()]
      .filter(
        (reservation) =>
          reservation.siteId === siteId && OCCUPYING_STATUSES.has(reservation.status),
      )
      .map((r) => ({
        reservationId: r.id,
        zoneId: r.zoneId,
        household: { id: r.household.id, name: r.household.name, members: r.household.members, accessibleNeeded: r.household.accessibleNeeded },
        status: r.status,
        since: nowIso(r.createdAt),
      }))
      .sort((a, b) => a.since.localeCompare(b.since));
    const windowsOpen = (site.openWindows ?? []).length === 0;
    return {
      id: site.id,
      name: site.name,
      district: site.district,
      open: windowsOpen || site.openWindows.some(({ from, to }) => at >= from && at <= to),
      openWindows: site.openWindows,
      zones,
      totals: {
        capacity: totals.capacity,
        accessibleBeds: totals.accessibleBeds,
        occupied: totals.occupiedGeneral + totals.occupiedAccessible,
        occupiedGeneral: totals.occupiedGeneral,
        occupiedAccessible: totals.occupiedAccessible,
        available: totals.capacity - totals.occupiedGeneral - totals.occupiedAccessible,
        availableAccessible: totals.accessibleBeds - totals.occupiedAccessible,
      },
      waiting: queue,
      active,
    };
  }

  function getSiteView(token, siteId) {
    const staff = authenticate(token);
    const site = getSite(siteId);
    assertSiteJurisdiction(staff, site, "查询");
    return siteView(site.id);
  }

  function getReservationView(token, reservationId) {
    const staff = authenticate(token);
    const s = state();
    const reservation = getReservation(reservationId);
    assertSiteJurisdiction(staff, getSite(reservation.siteId), "查询");
    return reservationResponse(s, reservation, false);
  }

  /** 沿变更记录解释该户床位为何被锁定或释放。 */
  function reservationHistory(token, reservationId) {
    const staff = authenticate(token);
    const reservation = getReservation(reservationId);
    assertSiteJurisdiction(staff, getSite(reservation.siteId), "查询");
    const s = state();
    const related = s.events.filter(
      (event) =>
        event.data.reservationId === reservationId ||
        event.data.reservation?.id === reservationId,
    );
    return { reservationId, timeline: related.map((event) => explainEvent(s, event)) };
  }

  function siteHistory(token, siteId) {
    const staff = authenticate(token);
    const site = getSite(siteId);
    assertSiteJurisdiction(staff, site, "查询");
    const s = state();
    const related = s.events.filter((event) => {
      if (event.type === "SITE_REGISTERED") return event.data.site.id === siteId;
      return event.data.siteId === siteId || event.data.fromSiteId === siteId || event.data.toSiteId === siteId;
    });
    return { siteId, timeline: related.map((event) => explainEvent(s, event)) };
  }

  function explainEvent(s, event) {
    const base = {
      seq: event.seq,
      at: nowIso(event.at),
      type: event.type,
      actor: event.actor,
      reason: event.data.reason ?? null,
    };
    const reservationOf = (id) => s.reservations.get(id);
    switch (event.type) {
      case "SITE_REGISTERED":
        return { ...base, summary: `站点登记，含 ${event.data.site.zones.length} 个分区` };
      case "RESERVATION_CONFIRMED": {
        const r = event.data.reservation;
        return {
          ...base,
          summary: `锁定床位：${r.household.members - r.household.accessibleNeeded} 张普通床 + ${r.household.accessibleNeeded} 张无障碍床（分区 ${r.zoneId}）`,
          beds: { locked: { general: r.household.members - r.household.accessibleNeeded, accessible: r.household.accessibleNeeded }, released: { general: 0, accessible: 0 } },
        };
      }
      case "WAITLISTED":
        return { ...base, summary: event.data.reason ?? "进入等待队列" };
      case "PROMOTED": {
        const r = reservationOf(event.data.reservationId);
        const h = r?.household;
        return {
          ...base,
          summary: `等待递补，锁定 ${h ? h.members - h.accessibleNeeded : "?"} 张普通床 + ${h ? h.accessibleNeeded : "?"} 张无障碍床（分区 ${event.data.zoneId}）`,
        };
      }
      case "CANCELLED":
      case "MARKED_NO_SHOW": {
        const r = reservationOf(event.data.reservationId);
        const h = r?.household;
        const verb = event.type === "CANCELLED" ? "取消登记" : "标记失约";
        return {
          ...base,
          summary: `${verb}，释放 ${h ? h.members - h.accessibleNeeded : "?"} 张普通床 + ${h ? h.accessibleNeeded : "?"} 张无障碍床`,
          beds: h
            ? { locked: { general: 0, accessible: 0 }, released: { general: h.members - h.accessibleNeeded, accessible: h.accessibleNeeded } }
            : undefined,
        };
      }
      case "CHECKED_IN":
        return { ...base, summary: "到场核销，床位保持占用" };
      case "REASSIGNED": {
        const r = reservationOf(event.data.reservationId);
        const h = r?.household;
        const d = event.data;
        let summary;
        if (d.fromZoneId == null && d.newStatus === "waiting") {
          summary = `等待中家庭转移至站点 ${d.toSiteId} 的队列尾部，未占用床位`;
        } else if (d.fromZoneId == null && d.newStatus === "confirmed") {
          summary = `等待中家庭改派至站点 ${d.toSiteId}，有空余容量，锁定分区 ${d.toZoneId}`;
        } else if (h) {
          summary = `改派：释放原分区 ${d.fromZoneId ?? "-"} 的 ${h.members - h.accessibleNeeded} 普通床 + ${h.accessibleNeeded} 无障碍床，在分区 ${d.toZoneId ?? "-"} 重新锁定`;
        } else {
          summary = "改派";
        }
        return {
          ...base,
          summary,
          from: { siteId: d.fromSiteId, zoneId: d.fromZoneId },
          to: { siteId: d.toSiteId, zoneId: d.toZoneId },
        };
      }
      default:
        return { ...base, summary: event.type };
    }
  }

  return {
    registerSite,
    registerStaff,
    reserve,
    cancel,
    checkIn,
    markNoShow,
    reassign,
    getSite: getSiteView,
    getReservation: getReservationView,
    reservationHistory,
    siteHistory,
    // 测试与引导用
    _state: state,
  };
}
