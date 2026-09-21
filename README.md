# 避难所容量预约服务

避难所开放当天的容量预约后端：每处避难所按**分区**设置容量与无障碍床位及开放时段；
一户家庭的申请**整体成功或有序等待**，杜绝超卖、拆户与未经授权的跨辖区挪用。

- 纯 Node.js（≥ 20），无第三方依赖，单进程可独立运行
- 所有变更以**追加式事件日志**（`data/events.log`）落盘，每条事件 fsync
- 服务器重启后重放日志，恢复预约、床位占用与候补次序；重复请求通过幂等键安全重放

## 运行

```bash
npm start                 # 默认端口 3000，首次启动写入演示数据
PORT=3100 npm start       # 指定端口
DATA_FILE=/path/events.log npm start
npm test                  # 24 项单元/集成测试
```

首次启动若日志为空，会自举演示指挥员 `cmd-demo`、两名社工与两处避难所。

## 核心规则

| 需求 | 实现 |
| --- | --- |
| 分区容量 / 无障碍床位 / 开放时段 | 建站点时声明；床位 ID 形如 `s1:A:001`，前 N 张为无障碍床 |
| 整户成功或等待 | 单一分区内必须同时满足普通床与无障碍床数量，否则整户进入 FIFO 候补 |
| 不超卖 | 全部写操作经同一互斥队列「校验 → 落盘 → 归约」，并发放心 |
| 无障碍床位不被挪用 | 无障碍床只分配给声明了无障碍需求的成员 |
| 释放后自动递补 | 取消 / 改派释放床位后按候补次序递补；放不下的家庭跳过并保留原位 |
| 辖区隔离 | 工作人员仅可操作所属 `districts` 的站点；指挥员可跨区 |
| 跨区改派授权 | 普通社工跨辖区改派须提供 `authorization` 授权凭证 |
| 身份与原因留痕 | 改派、取消、候补取消、核销均记录 `workerId` 与 `reason` |
| 开放时段核销 | 到场核销校验站点 `openHours`，闭馆时段拒绝 |
| 幂等 | 登记 / 改派可带 `idempotencyKey`；同键同请求返回首次结果，同键不同请求报 409 |
| 崩溃恢复 | 事件日志重放；预约、队列顺序、幂等表全部还原 |
| 床位审计 | `GET /shelters/:id/beds?bedId=…` 沿事件流解释每张床锁定/释放的原因 |

## HTTP 接口

所有请求与响应均为 JSON；写操作鉴权使用 `X-Worker-Id` 头。

### 管理

- `POST /admin/bootstrap` — 系统为空时自举首位指挥员（之后调用返回 409）
- `POST /admin/workers` — 指挥员登记工作人员 `{ workerId, name, role: STAFF|COMMANDER, districts }`
- `POST /shelters` — 指挥员创建避难所

```json
{
  "id": "s1",
  "name": "县第一中学避难所",
  "district": "NORTH",
  "openHours": { "opens": "00:00", "closes": "23:59" },
  "zones": [
    { "code": "A", "capacity": 20, "accessibleCapacity": 4 }
  ]
}
```

- `GET /shelters` — 当前身份可见的站点及汇总
- `GET /shelters/:id` — 站点详情：分区可用/已占用、无障碍余量、排队家庭及最新状态

### 登记与候补

- `POST /shelters/:id/applications`

```json
{
  "householdId": "hh-1001",
  "size": 4,
  "accessibleNeed": 1,
  "preferredZoneCode": "A",
  "reason": "开放日现场登记",
  "idempotencyKey": "终端请求UUID-可选"
}
```

成功返回 `outcome: "RESERVED"` 与锁定的 `bedIds`；放不下时返回
`outcome: "WAITING"` 与候补 `entryId`、`position`。

- `GET /households/:id` — 查询家庭当前预约或候补（含状态变更历史）
- `POST /waitlist/:entryId/cancel` — 主动退出候补（需 `reason`）

### 改派 / 取消 / 核销

- `POST /reservations/:id/reassign` — `{ targetShelterId, targetZoneCode?, reason, authorization?, idempotencyKey? }`
- `POST /reservations/:id/cancel` — `{ reason }`，释放后自动递补
- `POST /reservations/:id/check-in` — `{ reason }`，须在开放时段内；已核销不可再改派或取消

### 审计

- `GET /shelters/:id/beds` — 该站点全部床位变更时间线
- `GET /shelters/:id/beds?bedId=s1:A:001` — 单张床位为何被锁定/释放

每条记录含事件序号、时间、动作（LOCKED/RELEASED）、来源（登记/取消/候补递补/改派迁入迁出）、
家庭、预约、操作人、原因与跨区授权凭证。

## 代码结构

```
src/domain.js   纯函数事件归约（床位/预约/候补/幂等表）
src/store.js    追加式 JSONL 事件日志与启动重放
src/service.js  业务规则：分配、权限、FIFO 递补、审计（写操作串行互斥）
src/app.js      HTTP 路由
src/server.js   启动引导与优雅关闭
src/seed.js     首次启动演示数据
test/           容量、幂等、权限、开放时段、持久化恢复与 HTTP 集成测试
```

## 说明

事件日志是唯一持久化来源，备份只需复制该文件。当前为单实例设计；
多实例部署时应把写入串行点替换为带事务的共享存储。
真实居民资料不得提交到版本库，接口中仅使用不可变标识。
