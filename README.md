# 跨航站楼中转资料服务

仓库保存航班衔接、航站楼通行耗时和特殊旅客缓冲条件的脱敏样例，并提供最小 Node.js 健康接口。`fixtures/context.json` 中的两个行程跨越不同航站楼，其中一个需要重新安检，所有时间均保留原始时区偏移量。

运行 `npm test` 检查资料格式，运行 `npm start` 后访问 `GET /health`。Node.js 版本不得低于 20；也可通过 `docker compose up --build` 启动，并用 `APP_PORT` 修改宿主机端口。真实旅客身份和生产凭据不得写入仓库。
