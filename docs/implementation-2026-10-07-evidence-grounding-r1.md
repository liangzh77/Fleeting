# R1 修复：聚合证据候选筛选

日期：2026-10-07
状态：修复与执行方验证完成，待独立复验；不是 approve 或部署许可。

## 仅修复 R1

- `src/ai.ts`：`groundQuote()` 接收候选接受条件，匹配顺序仍为精确 → 折叠空白 → 标点归一。
- 精确命中必须通过供给约束才返回；精确出现的文本切片相同，因此一次接受检查等价于检查所有精确候选。未供给时继续归一化策略，不再提前终止。
- 每个归一化策略按 `indexOf(needle, at + 1)` 枚举全部（包括重叠）候选，沿既有 starts/ends 映射对完整原文执行 slice；不被供给的候选跳过，继续搜索其他候选及下一策略。
- `evidence()` 将同 id 的实际供给文本 `includes(slice)` 作为候选接受条件。未供给片段仍丢弃；不返回归一化文本，不放宽 id 校验，不扩大聚合引用范围。
- 未修改其他产品代码、配置、前端、调度或原独立验收报告/探针。

## 正式回归

新增 `tests/ai-grounding-candidates.test.ts`，6 项测试覆盖报告中三个变体 × 普通聚合/截断后压缩流程。

每项先运行精确供给基线，再返回空白/标点变体，断言：

1. 聚合和压缩实际输入只包含该 id 的 supplied 精确证据。
2. 完整原文中的未供给同形片段不能遮蔽 supplied；落库 quote 全等于 supplied、长度相等且为完整原文子串。
3. 普通聚合成功且没有结构修复；压缩模式确实触发两个压缩回顾及压缩聚合，压缩输出中的有效洞察与精确证据保留。
4. 同一链路改为引用真实存在但未供给的片段，压缩时条目被丢弃，最终聚合仅修复一次后明确失败；旧 ready 的 id/data 完全保留，库中成功结果不含越界引文。

## 验证与边界

完整 stdout/stderr（含命令及退出码）：`docs/validation-2026-10-07-evidence-grounding-r1-output.txt`。

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm test` | exit 0，61/61 |
| `npm run build` | exit 0 |
| `npm run test:production` | exit 0 |
| `CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' npm run test:browser` | exit 0 |
| `npm run format:check` | exit 0 |
| 显式重跑 `tests/review-grounding-probe.ts`（Chrome 路径同上） | exit 0，16/16 |

执行前清除继承的 LLM_BASE_URL/LLM_API_KEY/LLM_MODEL/LLM_REASONING_EFFORT/LLM_EXTRA_BODY、APP_ORIGIN/APP_TIMEZONE、DATABASE_PATH/PASSWORD_HASH/FLEETING_CONFIG；随后 FLEETING_CONFIG 指向 mktemp 隔离目录中的不存在文件，DATABASE_PATH 指向同目录的 unused.sqlite。测试使用合成数据、注入 mock fetch、内存或临时数据库；生产/浏览器测试仅运行自己的临时服务。

没有读取真实私有配置/数据库、调用真实模型、连接或重启现有服务。未执行部署或修改私有推理配置。原 needs_changes 报告保留，等待独立复验。

修复文件 SHA-256：

```text
191c65201db6025dae12fcad1cbb804c4d74ea6d20e705f078a3c26b666eb761  src/ai.ts
62dc80ede73694b44465227daebf21315615d045fae57e380849f99691e9fa29  tests/ai-grounding-candidates.test.ts
```
