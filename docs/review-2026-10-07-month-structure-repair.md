# 月度结构修复：独立验收交接（待执行）

**状态：尚未独立验收；不是 approve / needs_changes 结论。**

当前会话只有实现方，不能以实现方自查或同一份测试输出冒充独立验收。正式独立报告应由主会话安排独立审查者读取代码、执行测试并自行构造探针后替换本文件。

## 审查范围

- `src/ai.ts`：软/硬上限，围栏解析，字段安全诊断，修复一次，预算/截断/压缩顺序，叶与聚合资料证据边界，日两阶段校验。
- `src/config.ts`：环境优先，extraBody JSON 字符串与长度/禁止键验证，请求默认无推理参数与合并顺序。
- `tests/ai-structure.test.ts`、`tests/ai-structure-evidence.test.ts` 及既有测试。
- `README.md`、`config.example.json`、`.prettierignore`。

## 必须独立复现

1. 多给主题/洞察/变化/问题裁剪，主题统计与保留项一致。
2. 必填空/少洞察/缺证据：不能静默成功；一次修复合法才成功。
3. 裸/json围栏解析；无效 JSON 进入修复。
4. 月分类/叶/聚合、日第一阶段/核对的修复成功与持续错误。
5. 修复失败含阶段/字段、不含原文或正文，API 保留旧 ready。
6. HTTP/网络/超时不修复；Truncated（包括修复返回 length）仍拆分；层级压缩仍有界；修复计入 512 / 60000 预算。
7. 默认请求无推理字段；配置按需发送；extraBody 非法/禁止键在启动时报错。

实现方六项正式输出：`docs/validation-2026-10-07-month-structure-repair.md`。执行结果/空字段与缺证据策略：`docs/implementation-2026-10-07-month-structure-repair.md`。

独立验收同样禁止读取真实配置/数据库、调用真实模型或重启现有服务。验收通过后由主会话决定部署。
