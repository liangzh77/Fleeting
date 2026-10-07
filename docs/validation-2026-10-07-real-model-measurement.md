# 真实模型实测：思考档位与生成耗时（2026-10-07）

对应用户要求「用 10 月 4 号的内容测一下，到底是多长时间能够整理完成」。使用用户自己的 `config.local.json`（不打印任何凭据）与真实私有库内 2026-10-04 / 2026-10 记录，通过临时脚本 `scripts/__measure.ts` 调用 `Ai.generate()`，事后已删除该脚本。原文与模型返回内容均未写入本文件或日志。

## 结论

1. **App 从未发送任何 thinking / reasoning 参数**（拦截请求体确认：默认请求键里没有 `reasoning*` / `thinking*`）。
2. 服务商 `deepseek-v4-1-flash-260910` **默认开启思考**：连"返回 {ok:true}"都消耗 42 reasoning tokens，并在 `message` 中返回 `reasoning_content`。
3. 该服务商支持的关闭方式：`reasoning_effort:"none"`（0 reasoning tokens）、`thinking:{"type":"disabled"}`（0）。不生效：`reasoning_effort:"minimal"`（50）、`enable_thinking:false`（60）。
4. 思考默认开启会拖慢约 3 倍，且因 reasoning tokens 计入 `max_tokens` 而更容易触发输出截断（月任务 22 次调用、737 秒后仍失败）。

## 实测数据

| 场景 | 思考 | 耗时 | 模型调用 | 结果 |
| --- | --- | --- | --- | --- |
| 日整理 2026-10-04（1 条 2539 字） | 默认 | 101.1 s | 4 | 成功 |
| 日整理 2026-10-04 | `reasoning_effort:"none"` | 30.4 s | 4 | 成功 |
| 洞察 2026-10 | 默认 | 737.3 s | 22 | **失败**（截断耗尽） |
| 洞察 2026-10 | `none`（旧代码） | 45–69 s | 4–6 | 失败：证据非逐字 |
| 洞察 2026-10 | `none`（本轮修复后） | **63.8 s** | 5 | **成功** |

日整理 4 次调用来自 2539 字记录按 2000 字上限切成 2 个分片 × 2 阶段（初稿 + 对照核对）。

## 失败根因（非「模型不行」）

- 真实模型给出的 `evidence.quote` 常常**不是原文逐字**：实测一条 40 字引文只在折叠空白后才匹配（原文分片内偏移 1336），另一条 21 字引文任何朴素策略都不匹配（跨分片或改写）。旧校验 `text.includes(quote)` 只要一条不匹配就整份月报告失败。
- 另一条旧缺陷是模型多给（超过 prompt 上限条数）或字段为空也直接判失败，且没有修复重试。

## 部署后核验（真实数据）

- 日整理 2026-10-04：`ready`，1 条来源全覆盖，43 个分段无空段。
- 洞察 2026-10：`ready`，4 条分类 / total 4 / activeDays 3；insights 4、changes 3、connections 3、questions 4，**全部证据 id 均属本次范围，且每条 quote 都是对应原文的逐字连续子串**。过程中 1 条无法落地的证据被丢弃并在日志说明，报告仍然完成。

## 配置改动

- `config.local.json` 增加 `llm.reasoningEffort: "none"`（文件权限保持 0600）。如该服务商将来不支持该字段导致 400，删除这一行即恢复原行为。
- 默认行为未改：未配置时不发送任何推理参数；`config.example.json` 与 README 说明实测依据。
