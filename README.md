# 跨航站楼中转决策服务

雷雨大面积延误后，中转服务主管需要在十几分钟内判定：哪些旅客还能赶上后续航班（`OK`）、
哪些处于风险窗口需要重点盯（`RISK`）、哪些已经失接应提前改签或放弃（`MISSED`）。

本服务在既有资料包（`fixtures/context.json`）基础上实现判定与处置闭环：

- 判定不仅看计划落地时间，而是比较 **实际可用时间** 与 **最短衔接时间（MCT）**：
  基础 MCT + 动线触发的重新安检/边检分量 + 旅客个体缓冲（轮椅、婴儿、过境检查）。
- 风险来源按通行耗时段展开（下机、摆渡车、步行、安检、边检、特殊缓冲），主管可直接看到
  「风险来自哪一段」。
- 两条跨航站楼行程 `cx-1001`（T2→T3，含摆渡车+复检）与 `cx-1002`（T1→T2，含边检+复检），
  所有航班时间保留原始时区偏移量；跨午夜（22:50→次日 00:35）按时区正确计算。
- 规则按**到达时刻**选版生效（`mct-2026-09` / `mct-2026-10`），每条建议保存判定时依据的
  `ruleVersion` 与资料包 `contextVersion`。
- 同一 `eventId` 重复推送幂等，不产生第二份处置；上游时间反复变化时只重算 `PROPOSED`
  建议，柜台已执行的 `RETAIN / REBOOK / ABANDON` 决定一旦确认即冻结，后台不得覆盖。
- 同行旅客按组处理（一条组建议），婴儿、轮椅、过境检查成员各自带缓冲，组结论取最紧张成员；
  旅客侧接口只能看到本人结论，同行者只显示序号，看不到他人姓名、标记或行程。
- `GET /waves/:waveId/priority` 按「失接 > 风险 > 可衔接，同档富余越少越靠前」列出一个到达
  波次中最需要先处理的人。

运行 `npm test`（18 项测试），`npm start` 后默认 `http://localhost:3000`。
也可 `docker compose up --build`，用 `APP_PORT` 修改宿主端口；运行状态写入挂载卷。
Node.js 版本不得低于 20。真实旅客身份和生产凭据不得写入仓库。

## 判定模型

```
所需最短衔接 = baseMinutes
             + (动线含 SECURITY     ? securityMinutes    : 0)
             + (动线含 IMMIGRATION  ? immigrationMinutes : 0)
             + Σ 旅客 flags 在规则 buffers 中的取值
富余分钟     = (实际起飞 - 实际到达) - 所需最短衔接
status       = slack < 0           → MISSED
             = 0 ≤ slack ≤ 风险窗口 → RISK   (默认 20 分钟)
             = slack > 风险窗口     → OK
```

实际到/发时间缺省回落到计划时间；规则按到达时刻落在规则的 `[effectiveFrom, effectiveTo]`
区间选版，同时刻多版取 `effectiveFrom` 最晚者。

## HTTP 接口

最小角色模型用 `x-role` 头表达（`supervisor` / `counter` / `passenger` / `upstream`），
生产环境应替换为网关签发的身份凭证。旅客身份经 `x-passenger-id` 头传入。

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| POST | `/passengers` | supervisor | 登记旅客/同行组（`groupId` 相同者成组），立即生成初版建议 |
| POST | `/events` | upstream, supervisor | 推送运行事件（`ARRIVAL`/`DEPARTURE` 实际时间），幂等 |
| GET | `/advice` | supervisor | 建议列表，可 `?waveId=` 过滤 |
| GET | `/advice/:id` | supervisor, counter | 单条建议（主管视图，含分段风险与版本依据） |
| POST | `/advice/:id/decision` | counter, supervisor | 执行 `RETAIN`/`REBOOK`/`ABANDON`，确认后冻结 |
| GET | `/waves/:id/priority` | supervisor, counter | 波次处置优先级 |
| GET | `/me/advice` | passenger | 旅客本人视图（隐藏他人身份与行程） |
| GET | `/health` | — | 健康状态与资料版本 |

### 示例

```bash
# 登记一家三口（婴儿单独带 INFANT 缓冲）
curl -s localhost:3000/passengers -H 'x-role: supervisor' -H 'content-type: application/json' -d '{
  "passengers": [
    {"passengerId":"p-mom","groupId":"g1","name":"王梅","journeyId":"cx-1001","waveId":"w-2250","flags":[]},
    {"passengerId":"p-dad","groupId":"g1","name":"王强","journeyId":"cx-1001","waveId":"w-2250","flags":[]},
    {"passengerId":"p-baby","groupId":"g1","name":"王婴儿","journeyId":"cx-1001","waveId":"w-2250","flags":["INFANT"]}
  ]}'

# 上游推送实际到达（同一 eventId 重复推不会产生第二份处置）
curl -s localhost:3000/events -H 'x-role: upstream' -H 'content-type: application/json' -d '{
  "eventId":"evt-1","journeyId":"cx-1001","type":"ARRIVAL",
  "actualTime":"2026-09-12T23:20:00+08:00"}'

# 主管看波次里先处理谁
curl -s 'localhost:3000/waves/w-2250/priority' -H 'x-role: supervisor'

# 柜台执行改签后该建议冻结
curl -s localhost:3000/advice/<adviceId>/decision -H 'x-role: counter' \
  -H 'content-type: application/json' -d '{"action":"REBOOK","by":"counter-03"}'

# 旅客只看自己
curl -s localhost:3000/me/advice -H 'x-role: passenger' -H 'x-passenger-id: p-mom'
```

## 代码结构

| 文件 | 职责 |
| --- | --- |
| `src/domain.js` | 时间解析、规则选版、MCT 计算、单人与成组判定、波次排序（纯函数） |
| `src/store.js` | JSON 文件原子持久化、事件去重、旅客/建议存取 |
| `src/service.js` | 建议生命周期：登记、事件驱动重算（仅 `PROPOSED`）、柜台冻结、两类视图 |
| `src/server.js` | HTTP 路由与角色隔离 |
| `fixtures/context.json` | 两条行程、两段动线耗时、两套生效规则与特殊旅客缓冲 |
| `test/` | 领域、服务、HTTP 三层测试（跨午夜、时区偏移、幂等、冻结、脱敏、重启恢复） |

## 已知边界

- 存储为单文件 JSON，适配柜台级单机/单副本部署；多副本水平扩展需换用事务型数据库，
  事件幂等键加唯一约束。
- 角色鉴权是占位实现；旅客自助接口的身份头必须由可信网关注入，不能由旅客自报。
- 资料包换版（`contextVersion`）目前随下次重算体现在建议上；需要「按历史版本可追溯复算」时，
  建议记录已保存当时的版本号与分量，可据此离线审计。
