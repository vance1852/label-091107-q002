// 纯函数状态归约：所有状态变化都来自一个已提交事件。
// service 层负责校验，归约器假定事件合法（事件只能由 service 产生）。

export function initialState() {
  return {
    shelters: {}, // shelterId -> shelter
    workers: {}, // workerId -> { id, name, role, districts }
    reservations: {}, // reservationId -> reservation
    waitlist: {}, // entryId -> waitlist entry
    households: {}, // householdId -> { kind, refId, shelterId }
    idempotency: {}, // key -> { request, result }
    events: [], // 全量事件，即审计轨迹
  };
}

function makeBeds(shelterId, zone) {
  const beds = [];
  for (let i = 1; i <= zone.capacity; i += 1) {
    beds.push({
      id: `${shelterId}:${zone.code}:${String(i).padStart(3, "0")}`,
      accessible: i <= zone.accessibleCapacity,
      reservationId: null,
    });
  }
  return beds;
}

function lockBeds(shelter, bedIds, reservationId) {
  const wanted = new Set(bedIds);
  for (const zone of shelter.zones) {
    for (const bed of zone.beds) {
      if (wanted.has(bed.id)) {
        if (bed.reservationId) {
          throw new Error(`床位 ${bed.id} 已被占用，事件归约失败`);
        }
        bed.reservationId = reservationId;
      }
    }
  }
}

function releaseBeds(shelter, bedIds) {
  const wanted = new Set(bedIds);
  for (const zone of shelter.zones) {
    for (const bed of zone.beds) {
      if (wanted.has(bed.id)) bed.reservationId = null;
    }
  }
}

function rememberIdempotency(state, key, request, result) {
  if (key) state.idempotency[key] = { request, result };
}

export function applyEvent(state, event) {
  state.events.push(event);
  switch (event.type) {
    case "worker-registered": {
      state.workers[event.worker.id] = { ...event.worker };
      break;
    }

    case "shelter-created": {
      const { shelter } = event;
      state.shelters[shelter.id] = {
        ...shelter,
        zones: shelter.zones.map((zone) => ({
          ...zone,
          beds: makeBeds(shelter.id, zone),
        })),
        queue: [],
      };
      break;
    }

    case "application-accepted": {
      const shelter = state.shelters[event.shelterId];
      lockBeds(shelter, event.bedIds, event.reservationId);
      state.reservations[event.reservationId] = {
        id: event.reservationId,
        householdId: event.householdId,
        shelterId: event.shelterId,
        zoneCode: event.zoneCode,
        size: event.size,
        accessibleNeed: event.accessibleNeed,
        bedIds: [...event.bedIds],
        status: "RESERVED",
        createdAt: event.at,
        updatedAt: event.at,
        lastReason: event.reason,
        history: [{ at: event.at, action: "RESERVED", reason: event.reason, workerId: event.workerId }],
      };
      state.households[event.householdId] = {
        kind: "reservation",
        refId: event.reservationId,
        shelterId: event.shelterId,
      };
      rememberIdempotency(state, event.idempotencyKey, event.request, event.result);
      break;
    }

    case "waitlist-joined": {
      const entry = {
        id: event.entryId,
        householdId: event.householdId,
        shelterId: event.shelterId,
        size: event.size,
        accessibleNeed: event.accessibleNeed,
        requestedZoneCode: event.requestedZoneCode ?? null,
        status: "WAITING",
        joinedAt: event.at,
        updatedAt: event.at,
        lastReason: event.reason,
        history: [{ at: event.at, action: "JOINED", reason: event.reason, workerId: event.workerId }],
      };
      state.waitlist[entry.id] = entry;
      state.shelters[event.shelterId].queue.push(entry.id);
      state.households[event.householdId] = {
        kind: "waitlist",
        refId: entry.id,
        shelterId: event.shelterId,
      };
      rememberIdempotency(state, event.idempotencyKey, event.request, event.result);
      break;
    }

    case "reservation-reassigned": {
      const old = state.reservations[event.oldReservationId];
      const fromShelter = state.shelters[event.fromShelterId];
      releaseBeds(fromShelter, event.releasedBedIds);
      old.status = "REASSIGNED";
      old.updatedAt = event.at;
      old.lastReason = event.reason;
      old.history.push({
        at: event.at,
        action: "REASSIGNED_OUT",
        reason: event.reason,
        workerId: event.workerId,
        toShelterId: event.toShelterId,
        toZoneCode: event.toZoneCode,
      });

      const toShelter = state.shelters[event.toShelterId];
      lockBeds(toShelter, event.lockedBedIds, event.newReservationId);
      state.reservations[event.newReservationId] = {
        id: event.newReservationId,
        householdId: old.householdId,
        shelterId: event.toShelterId,
        zoneCode: event.toZoneCode,
        size: event.size,
        accessibleNeed: event.accessibleNeed,
        bedIds: [...event.lockedBedIds],
        status: "RESERVED",
        createdAt: event.at,
        updatedAt: event.at,
        lastReason: event.reason,
        reassignedFrom: event.oldReservationId,
        history: [
          {
            at: event.at,
            action: "REASSIGNED_IN",
            reason: event.reason,
            workerId: event.workerId,
            fromShelterId: event.fromShelterId,
            fromZoneCode: event.fromZoneCode,
          },
        ],
      };
      if (state.households[old.householdId]?.refId === old.id) {
        state.households[old.householdId] = {
          kind: "reservation",
          refId: event.newReservationId,
          shelterId: event.toShelterId,
        };
      }
      rememberIdempotency(state, event.idempotencyKey, event.request, event.result);
      break;
    }

    case "reservation-cancelled": {
      const reservation = state.reservations[event.reservationId];
      releaseBeds(state.shelters[reservation.shelterId], reservation.bedIds);
      reservation.status = "CANCELLED";
      reservation.updatedAt = event.at;
      reservation.lastReason = event.reason;
      reservation.history.push({
        at: event.at,
        action: "CANCELLED",
        reason: event.reason,
        workerId: event.workerId,
      });
      const pointer = state.households[reservation.householdId];
      if (pointer?.kind === "reservation" && pointer.refId === reservation.id) {
        delete state.households[reservation.householdId];
      }
      break;
    }

    case "reservation-checked-in": {
      const reservation = state.reservations[event.reservationId];
      reservation.status = "CHECKED_IN";
      reservation.updatedAt = event.at;
      reservation.lastReason = event.reason;
      reservation.history.push({
        at: event.at,
        action: "CHECKED_IN",
        reason: event.reason,
        workerId: event.workerId,
      });
      break;
    }

    case "waitlist-entry-cancelled": {
      const entry = state.waitlist[event.entryId];
      const shelter = state.shelters[entry.shelterId];
      shelter.queue = shelter.queue.filter((id) => id !== entry.id);
      entry.status = "CANCELLED";
      entry.updatedAt = event.at;
      entry.lastReason = event.reason;
      entry.history.push({
        at: event.at,
        action: "CANCELLED",
        reason: event.reason,
        workerId: event.workerId,
      });
      const pointer = state.households[entry.householdId];
      if (pointer?.kind === "waitlist" && pointer.refId === entry.id) {
        delete state.households[entry.householdId];
      }
      break;
    }

    case "waitlist-promoted": {
      const shelter = state.shelters[event.shelterId];
      shelter.queue = shelter.queue.filter((id) => id !== event.entryId);
      const entry = state.waitlist[event.entryId];
      entry.status = "PROMOTED";
      entry.updatedAt = event.at;
      entry.lastReason = event.reason;
      entry.history.push({
        at: event.at,
        action: "PROMOTED",
        reason: event.reason,
        workerId: event.workerId,
        reservationId: event.reservationId,
        zoneCode: event.zoneCode,
      });

      lockBeds(shelter, event.bedIds, event.reservationId);
      state.reservations[event.reservationId] = {
        id: event.reservationId,
        householdId: event.householdId,
        shelterId: event.shelterId,
        zoneCode: event.zoneCode,
        size: event.size,
        accessibleNeed: event.accessibleNeed,
        bedIds: [...event.bedIds],
        status: "RESERVED",
        createdAt: event.at,
        updatedAt: event.at,
        lastReason: event.reason,
        promotedFrom: event.entryId,
        history: [{ at: event.at, action: "PROMOTED", reason: event.reason, workerId: event.workerId }],
      };
      if (state.households[event.householdId]?.refId === event.entryId) {
        state.households[event.householdId] = {
          kind: "reservation",
          refId: event.reservationId,
          shelterId: event.shelterId,
        };
      }
      break;
    }

    default:
      throw new Error(`未知事件类型：${event.type}`);
  }
  return state;
}
