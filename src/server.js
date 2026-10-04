// 服务入口：从 JSONL 事件日志重放状态后启动 HTTP。
// 用法：node src/server.js [--file data/eventlog.jsonl] [--port 8080]

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { EventStore } from "./application/eventStore.js";
import { TaxService } from "./application/taxService.js";
import { QueryService } from "./application/queryService.js";
import { createApp } from "./http/app.js";

const { values } = parseArgs({
  options: {
    file: { type: "string", default: "data/eventlog.jsonl" },
    port: { type: "string", default: process.env.PORT || "8080" },
  },
});

const store = await EventStore.fromFile(resolve(values.file));
const service = new TaxService(store);
const query = new QueryService(store);
const server = createApp(service, query);

server.listen(Number(values.port), () => {
  console.log(`消费税判定后端已启动：http://localhost:${values.port}`);
  console.log(`已重放事件：${store.all().length}（${values.file}）`);
});
