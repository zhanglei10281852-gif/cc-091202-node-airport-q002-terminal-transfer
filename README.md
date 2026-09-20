# 跨航站楼中转决策服务

雷雨大面积延误后，中转服务主管需要在十几分钟内判断：哪些旅客还能赶上后续航班（OK）、
哪些处于紧衔接需要加急引导（RISK）、哪些已经失接应提前改签（MISSED）。

本服务接收实际运行事件，按**评估当时生效的最短衔接规则（MCT）**逐旅客计算，
并把每次判断所依据的规则版本与数据哈希落盘。柜台一旦执行处置（保留/改签/放弃），
后台重算永远不再覆盖该决定。

## 判定模型

```
可用间隔 = 截载时刻(gateClose) − 预计/实际落地时刻
所需衔接 = 基础 MCT + 行程各通行段耗时 + 旅客个人缓冲
余量 slack = 可用间隔 − 所需衔接
```

- 通行段按行程 `steps` 逐段取值：`TRANSFER_BUS`（摆渡）、`SECURITY`（重新安检）、
  `IMMIGRATION`（边检/过境检查）、`WALK`（跨航站楼步行）；`DEBOARD` 并入基础 MCT。
- 个人缓冲只加给对应旅客：`INFANT` 婴儿、`WHEELCHAIR` 轮椅、
  `TRANSIT_VISA_REQUIRED` 需过境检查——同组旅客结论可以不同。
- `slack < 0`（或航班已实际起飞）为 **MISSED**；`0 ≤ slack ≤ 风险窗(默认20分钟)` 为 **RISK**；
  其余为 **OK**。
- 每个非 OK 结论附 `riskFrom` 反事实归因：逐段标注分钟数与"若该段清零结论能否回升"，
  主管可直接看到风险来自摆渡、边检还是安检。

所有时刻一律解析为绝对毫秒（epoch）后比较：跨午夜只是墙上时钟回绕，
带 `+08:00`/`Z`/`+05:30` 偏移量的 ISO 8601 字符串得到稳定结论；
无时区后缀的时间会被拒绝，避免按服务器本地时区静默解释。

## 规则版本

`fixtures/context.json` 的 `rules` 是版本化目录，每个版本带 `effectiveFrom`。
判断使用评估时刻已生效的最新版本；每次快照保存 `ruleVersion` 与输入数据的
SHA-256 `dataHash`，历史判断依据可追溯。航站楼对精确匹配优先，否则退回 `"*"` 通配规则。

## 运行

```bash
npm test          # 17 项单元 + HTTP 端到端测试
npm start         # 默认 :3000，审计日志 data/audit-log.jsonl
# 可选环境变量
PORT=3000 AUDIT_PATH=/var/log/mct.jsonl SUPERVISOR_TOKEN=... npm start
# 或 docker compose up --build（APP_PORT 改宿主端口，日志在 mct-data 卷）
```

生产部署必须通过 `SUPERVISOR_TOKEN` 设置主管令牌（默认值仅供本地开发）。
真实旅客身份和生产凭据不得写入仓库。

## 接口

主管侧全部需要请求头 `X-Supervisor-Token`；旅客侧无需令牌且只能按本人 ID 查询。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/events` | 推送运行事件（可单条或数组/`{events:[]}`），按 `eventId` **幂等**：重复推送返回 200 且不生成第二份处置 |
| GET | `/api/journeys/:id` | 主管视图：航段时刻、逐段 MCT、每位旅客状态/缓冲/`riskFrom`/锁定决定 |
| POST | `/api/decisions/confirm` | 柜台确认 `KEEP`/`REBOOK`/`ABANDON`；默认整组，可指定 `passengerIds`；带 `idempotencyKey` 防重复执行 |
| GET | `/api/waves?from=&to=` | 某计划落地波次中最需要先处理的人：未确认的 RISK 优先，其次 MISSED（越接近赶上越靠前），已确认者沉底 |
| GET | `/api/passengers/:id` | **旅客自助视图**：只含本人脱敏状态，不含航班号、同组或任何他人信息 |
| GET | `/api/journeys` | 行程清单 |
| GET | `/health` | 健康检查 |

运行事件类型：`ARRIVAL_ESTIMATED`、`ARRIVAL_ACTUAL`、`DEPARTURE_ESTIMATED`、
`DEPARTURE_ACTUAL`、`GATE_CLOSING`、`NOTE`。事件按 `occurredAt` 排序折叠，
乱序到达收敛到同一结果；实际时刻优先于预计，预计优先于计划。

## 确认锁定与审计

- 建议生命周期：`PROPOSED → CONFIRMED_{KEEP,REBOOK,ABANDON}`。
- 上游时刻反复变化时，只更新尚未确认的建议；柜台确认后该旅客行永久锁定，
  后续事件只追加 `locked_observation`（主管仍能看到最新观察值），
  `executedDecision` 不会被后台重算覆盖；尝试改判返回 `conflict`。
- 所有摄入、建议、确认以只追加 JSONL 写入 `AUDIT_PATH`，重启时回放重建全部状态，
  包括锁定决定与已处理事件集合。

## 布局

```
src/domain/time.js    绝对时刻解析（强制时区偏移）
src/domain/rules.js   MCT 版本目录与航站楼对选择
src/domain/engine.js  纯函数评估引擎：分段耗时、个人缓冲、状态与归因
src/domain/store.js   事件幂等、建议生命周期、确认锁定、JSONL 审计/回放、波次排序
src/http.js           路由、主管鉴权、旅客视图隔离
src/server.js         启动入口
fixtures/context.json 两条跨航站楼行程（T2→T3 重新安检；T3→T2 过境边检）与两版 MCT
```
