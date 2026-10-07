# R1/R2 修复与验证（2026-10-07）

范围仅限独立验收报告 R1/R2；本记录是执行方验证，**不是新的独立 approve，不批准部署**。

## 修改

- `web/app.ts`：`report()` 在自身 GET 的异常路径核对 `epoch + reportScope + reportRequest`。过期错误直接消费，不再逃到通用按钮 catch；当前读取失败保留已有正文并提示状态。
- 同一请求负责安排下一次轮询/重试，去掉旧请求闭包的 catch。读取失败每 2500ms 重试，最多连续 3 次（初次读取加重试共 4 次）；成功重置失败计数，ready/failed 不再轮询。持续失败明确提示停止及切页/刷新恢复方法。切页、退出或更新请求令牌取消旧定时器/使旧在途结果失效；重试仅 GET，不重发生成 POST。
- `tests/browser-report-errors.ts`：新增真实 Chrome + Playwright 路由故障注入，使用内存 SQLite、合成记录、gate 模型 mock、随机 loopback 端口。`tests/browser.ts` 调用该回归，纳入原有 `npm run test:browser`。

## 新增 Chrome 断言

1. 日任务完成后的最终 GET 已发出并挂起 → 切到洞察启动月任务 → 旧 GET 返回 503。等待超过一个轮询周期，月任务仍 running、当前正文/消息不被旧错误覆盖，返回随笔草稿仍在。
2. 重新生成日整理 → 切到洞察再返回运行中的日任务 → 下一次轮询仅一次 503。当前页面显示重试提示、旧正文/草稿保留；释放模型后自动读取 ready、重新生成按钮可用、running 提示消失。只有一次成功后续 GET，ready 后等待超过一个周期无更多请求。
3. 持续 503 只产生初次读取 + 3 次重试，提示停止，再等待一个周期请求数不增加。
4. 重新进入范围触发失败后，切页/退出分别取消待执行重试；请求数与当前月消息保持不变。

## 完整验证

[六项命令完整原始输出](validation-2026-10-07-report-errors-output.txt)，均退出 0：

```sh
npm run typecheck
npm test                       # 24/24
npm run build
npm run test:production
CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:browser
npm run format:check
```

原有草稿、幂等重试、认证过期、跨午夜、旧日保存回今天范围隔离、日/月并行回归均通过。[首次新增 Chrome 回归完整输出](validation-2026-10-07-report-errors-browser-first.txt) 也通过。

开发过程：新增测试初次 typecheck 曾报 entry 可能为 null 与 NodeList 不可迭代；补 `assert(entry)` 并用 `Array.from` 后通过。未因此修改产品功能或放宽测试。最终上列六项均在修正后完整重新执行。

## 安全与待办

未读取私有配置或私人数据库，未调用真实模型，未访问/重启已有本地服务。build 更新构建资源，不代表完成部署；真实模型质量未实测。未改后端 AI/调度器、样式、手动同意或每日自动发送规则。下一步是独立复验 R1/R2；原缺陷探针与 needs_changes 报告保留作为历史材料，未篡改其结论。
