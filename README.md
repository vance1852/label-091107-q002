# 避难所容量预约后端

零依赖 Node.js 服务，管理避难所开放日的整户床位预约：分区容量（普通床 / 无障碍床分开核算）、
整户确认或 FIFO 有序等待、防超卖、辖区权限、改派授权、操作留痕、幂等登记与崩溃恢复。

- 运行要求：Node.js 20+
- 启动：`npm start`（可选 `PORT`，默认 3000；`DATA_DIR` 指定数据目录，默认 `./data`）
- 测试：`npm test`
- 关闭演示数据：`SEED_DEMO=0 npm start`
- 管理令牌：环境变量 `ADMIN_TOKEN`（默认 `setup-token`，生产环境必须覆盖）

首次启动会写入演示站点与工作人员，并在控制台**一次性打印**工作人员的访问令牌。

## 设计要点

| 需求 | 实现 |
| --- | --- |
| 分区容量、无障碍床位、开放时段 | 每站点多分区，普通床 = 总容量 − 无障碍床，两类床位**独立核算**；登记/核销校验开放时段 |
| 一户整体成功或有序等待 | 容量按户原子核算，任一资源不足则整户进入站点 FIFO 队列 |
| 不超卖 | 所有变更在单进程内严格串行（事件溯源），分区占用用模拟计数预演，先落盘后投影 |
| 有序等待 | 队首放不下即阻塞队列，后续家庭不能越位；已有排队时新登记一律排队；释放容量自动递补 |
| 辖区隔离 | 工作人员绑定辖区，只能操作本辖区站点；指挥员（coordinator）可跨辖区 |
| 跨区挪用受控 | 跨辖区改派只有指挥员可执行；目标站点满员或已有排队者时拒绝改派（不得插队） |
| 身份与原因留痕 | 登记、取消、核销、失约、改派、自动递补均记录操作人快照（工号/姓名/辖区）与原因 |
| 重复请求不多占床 | `Idempotency-Key` + 请求负载哈希；同户在同站点已有生效登记也会被拒绝 |
| 崩溃恢复 | 仅追加事件日志，每批事件带 `COMMIT` 标记；重启重放已提交批次，末尾残批自动截断 |
| 指挥员查询 | `GET /sites/:id` 返回各分区可用/已占用、站点汇总、排队家庭及已入住家庭 |
| 解释每个床位 | `GET /reservations/:id/history`、`GET /sites/:id/history` 给出锁定/释放的床位明细 |

## 身份与鉴权

- 管理接口：`Authorization: Bearer <ADMIN_TOKEN>`
- 业务接口（请求头）：
  - `X-Staff-Id: W-N1`
  - `X-Staff-Token: <创建工作人员时返回的令牌>`

## API

### 管理

- `POST /admin/sites` — 创建站点
  ```json
  {
    "id": "S-NORTH",
    "name": "北城体育馆避难所",
    "district": "北城区",
    "openWindows": [{ "from": 1700000000000, "to": 1700100000000 }],
    "zones": [
      { "id": "A", "name": "普通区", "capacity": 20, "accessibleBeds": 4 },
      { "id": "B", "name": "无障碍区", "capacity": 10, "accessibleBeds": 10 }
    ]
  }
  ```
  不配置 `openWindows` 视为全天开放。
- `POST /admin/staff` — 创建工作人员：`{ "id": "W-N1", "name": "周敏", "district": "北城区", "role": "worker" }`，
  `role` 为 `worker` 或 `coordinator`；响应中的 `token` 仅返回这一次。

### 登记

- `POST /reservations`（建议带 `Idempotency-Key` 请求头）
  ```json
  {
    "siteId": "S-NORTH",
    "zoneId": "A",
    "household": { "id": "H-001", "name": "张家", "members": 3, "accessibleNeeded": 1, "contact": "..." }
  }
  ```
  - 成功：`201`，`status` 为 `confirmed`（含 `zoneId`）或 `waiting`（含 `queuePosition`）。
  - 相同 `Idempotency-Key` 重放：返回同一预约，`replayed: true`，不重复占床。
  - 同键不同负载：`409 IDEMPOTENCY_KEY_REUSED`。
  - 同户在同站点已有生效登记：`409 DUPLICATE_ACTIVE_RESERVATION`。
  - 站点非开放时段：`409 SITE_CLOSED`。

### 变更（都需要原因与本辖区身份）

- `POST /reservations/:id/cancel` — `{ "reason": "投亲靠友" }`；释放床位并自动递补。
- `POST /reservations/:id/check-in` — 到场核销，`{ "reason": "全员到场" }`（可省略）。
- `POST /reservations/:id/no-show` — 标记失约并释放床位、自动递补。
- `POST /reservations/:id/reassign` —
  `{ "toSiteId": "S-SOUTH", "toZoneId": "C", "reason": "场馆检修" }`。
  - 跨辖区需指挥员；满员返回 `409 TARGET_AT_CAPACITY`；目标站点有排队者返回 `409 TARGET_HAS_QUEUE`。
  - 等待中家庭改派：目标站点有空床时直接确认，否则排到目标队尾。

### 查询

- `GET /sites/:id` — 分区级与站点级容量、`available`/`occupied`（普通/无障碍分列）、
  `waiting`（排队家庭及位次/状态）、`active`（已确认与已入住家庭）。
- `GET /reservations/:id` — 单个预约的最新状态与排队位次。
- `GET /reservations/:id/history` — 该户的床位锁定/释放时间线（含操作人与原因）。
- `GET /sites/:id/history` — 该站点全部相关变更。
- `GET /health` — 健康检查。

预约状态机：`waiting → confirmed → checked_in`；`confirmed`/`waiting`/`checked_in` 可
`cancelled`；`confirmed` 可 `no_show`。取消或失约释放的容量立即触发 FIFO 递补。

## 持久化与崩溃语义

数据文件：`$DATA_DIR/events.log`（JSON Lines）。

- 每个业务变更是一个原子批次：N 条事件行 + 1 条 `COMMIT` 行，写入后 `fsync`。
- 重启只重放带完整 `COMMIT` 的批次；进程在写批中途被杀（含写了一半的残行）时，
  启动会把日志截断到最后一个完整批次之后，不会出现"半个预约"。
- 等待队列次序、幂等键、工作人员令牌都在事件流中，恢复后完全保持。

## 代码结构

```
src/
  errors.js   业务错误与 HTTP 状态码映射
  store.js    事件日志、提交标记、重放投影、串行变更队列
  service.js  容量核算、FIFO 等待/递补、权限、幂等、审计解释
  http.js     路由、鉴权头、JSON 校验
  seed.js     首次启动演示数据
  server.js   装配与启动入口
test/         node:test 单元 + HTTP 集成 + 恢复测试
```
