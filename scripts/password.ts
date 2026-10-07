import { existsSync, writeFileSync, chmodSync } from "node:fs";
import { readPrivateConfig } from "../src/config.js";
import { emitKeypressEvents } from "node:readline";
import { hashPassword } from "../src/auth.js";
async function secret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY)
    throw new Error("请在本机交互终端运行，密码不应作为命令行参数或写入历史");
  emitKeypressEvents(process.stdin);
  return new Promise((resolve, reject) => {
    let value = "";
    const handler = (
      ch: string | undefined,
      key: { name?: string; ctrl?: boolean },
    ) => {
      if (key.ctrl && key.name === "c") {
        done();
        reject(new Error("已取消"));
      } else if (key.name === "return") {
        done();
        resolve(value);
      } else if (key.name === "backspace") value = value.slice(0, -1);
      else if (ch && !key.ctrl) value += ch;
    };
    function done() {
      process.stdin.off("keypress", handler);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    }
    process.stdin.on("keypress", handler);
    process.stdin.setRawMode(true);
    process.stdout.write(prompt);
    process.stdin.resume();
  });
}
try {
  const first = await secret("输入新密码（不能为空，不显示）：");
  const second = await secret("再次输入：");
  if (first !== second) throw new Error("两次密码不同");
  const path = process.env.FLEETING_CONFIG || "config.local.json";
  const config = existsSync(path)
    ? readPrivateConfig(path)
    : {
        origin: "http://localhost:3000",
        timezone: "Asia/Shanghai",
        database: "./data/fleeting.sqlite",
        llm: { baseUrl: "", apiKey: "", model: "" },
      };
  config.passwordHash = await hashPassword(first);
  delete config.password;
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  console.log(
    "密码哈希已写入私有配置。重启服务后旧会话失效；环境 PASSWORD_HASH 若已设置会覆盖此值。",
  );
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
