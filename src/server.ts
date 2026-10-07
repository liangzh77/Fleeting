import { loadConfig, migratePassword } from "./config.js";
import { Store } from "./store.js";
import { createApp } from "./app.js";
import { Ai } from "./ai.js";
import { Scheduler } from "./scheduler.js";
await migratePassword();
const config = loadConfig();
const store = new Store(config.database, config.timezone);
const scheduler = new Scheduler(store, new Ai(store, config));
const server = createApp(config, store).listen(
  Number(process.env.PORT || 3000),
  process.env.HOST || "127.0.0.1",
  () => {
    console.log("Fleeting 服务已启动（日志不记录原文或凭据）");
    scheduler.start();
  },
);
function stop() {
  scheduler.stop();
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
