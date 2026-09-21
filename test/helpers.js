import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../src/store.js";
import { CapacityService } from "../src/service.js";

export function makeService(now) {
  const dir = mkdtempSync(join(tmpdir(), "shelter-"));
  const store = new EventStore(join(dir, "events.log"));
  const service = new CapacityService(store, now ? { now: () => now } : {});
  return { dir, store, service };
}

export async function seedNorth(service) {
  await service.bootstrapCommander({ workerId: "cmd", name: "指挥员" });
  await service.registerWorker("cmd", {
    workerId: "north",
    name: "北区社工",
    role: "STAFF",
    districts: ["NORTH"],
  });
  await service.registerWorker("cmd", {
    workerId: "south",
    name: "南区社工",
    role: "STAFF",
    districts: ["SOUTH"],
  });
  await service.createShelter("cmd", {
    id: "s1",
    name: "北区避难所",
    district: "NORTH",
    openHours: { opens: "00:00", closes: "23:59" },
    zones: [
      { code: "A", capacity: 4, accessibleCapacity: 2 },
      { code: "B", capacity: 2, accessibleCapacity: 0 },
    ],
  });
  await service.createShelter("cmd", {
    id: "s2",
    name: "南区避难所",
    district: "SOUTH",
    openHours: { opens: "08:00", closes: "18:00" },
    zones: [{ code: "H", capacity: 3, accessibleCapacity: 1 }],
  });
}
