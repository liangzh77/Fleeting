# 部署验证记录：改为 https://liangz77.cn/fleeting/（2026-10-07）

## 0. 起因

用户原要求把应用迁到子域 `fleeting.liangz77.cn`；`fleeting.liangz77.cn` 在阿里云 DNS 没有 A 记录，
服务器上也没有 `aliyun` CLI/凭据，无法代加。用户随即改成路径部署：**应用挂在 `https://liangz77.cn/fleeting/`，
旧地址 `/private` 只留跳转**。

## 1. 切换时发现的真实故障（重要）

上一版 `/private` 反向代理「剥前缀」的部署**在浏览器里其实是坏的**，当时只用 curl 逐条验证，漏掉了它：

- `web/index.html` 的资源引用是根绝对路径（`/style.css`、`/app.js`、`/favicon.svg`），`web/app.ts` 的接口前缀也是 `/api`。
- 经 `handle_path /private/*` 反代后，上游看到的是根路径，于是 `curl https://liangz77.cn/private/app.js` **确实** 200；
  但浏览器打开的是 `https://liangz77.cn/private/`，页面里的 `/style.css`、`/app.js` 会被解析到**站点根**，
  落到 go-sites 静态站点上：

```
GET https://liangz77.cn/app.js    -> 404
GET https://liangz77.cn/style.css -> 404
GET https://liangz77.cn/favicon.svg -> 200   （主站自己的 favicon，掩盖了问题）
```

即：页面无样式、脚本不执行，登录框都不会出现。`curl` 只验证了「上游能被反代到」，
没有验证「浏览器按页面里的 URL 去取资源会发生什么」。

## 2. 修复：相对资源引用 + 由页面地址推导接口前缀

| 位置 | 改动 |
| --- | --- |
| `web/index.html` | 资源引用改为相对路径：`href="favicon.svg"`、`href="style.css"`、`src="app.js"` |
| `web/app.ts` | 新增 `apiBase = new URL(".", location.href).pathname.replace(/\/+$/, "")`；`fetch` 与两个导出链接改为 `apiBase + "/api/..."` |

性质：

- 根路径部署时 `apiBase === ""`，行为与之前完全一致；子路径部署时 `apiBase === "/fleeting"`。
- 相对资源引用要求文档 URL 以 `/` 结尾，因此 Caddy 必须把目录式 URL 收敛：`/fleeting` → 301 `/fleeting/`。
- 反向代理仍是 `handle_path`（剥掉 `/fleeting`），应用不需要知道前缀，`config.local.json` 的 `origin`
  仍然只能填站点根 `https://liangz77.cn`（Origin 校验是单值精确匹配，子路径不参与）。
- 登录 Session Cookie 的 `Path=/`（`__Host-` 也要求 `/`），与子路径无关。

## 3. 回归测试（本地）

新增 `tests/browser-base-path.ts`，用本地 `node:http` 反向代理**复现生产拓扑**（剥掉 `/fleeting` 前缀 → 应用），
并把 `config.origin` 设成代理地址（顺带覆盖 Origin 校验），真实 Chrome 断言：

- `GET /fleeting/style.css`、`GET /fleeting/app.js` 都是 200，且 `--paper` 令牌为 `#f5f2ea`（样式真的生效）；
- 整个页面生命周期内**没有任何站点根路径请求**（`offPath` 为空）；
- 登录（`POST /fleeting/api/entries` = 201）、原文落库 1 条、`GET /fleeting/api/session` = 200；
- 两个导出链接的 `href` 都在 `/fleeting/api/export?...` 下；
- 无 pageerror。

`npm run test:browser` 现在连跑 `tests/browser.ts` 与 `tests/browser-base-path.ts`。
**反向对照**：把 `public/index.html` 临时改回根绝对路径后，该测试如预期失败（登录框不出现），
说明它确实能拦住这次的故障模式。`tests/production.ts` 也加了「HTML 必须是相对引用」的断言。

六项检查全绿：`typecheck`、`62/62` 单元测试、`build`、`test:production`、`test:browser`（含子路径）、`format:check`。

## 4. Caddy 改动（go-sites 仓库 `Caddyfile`，同一段 `(main_site_routes)`）

`handle` 之间互斥且按书写顺序匹配，所以这些段落仍在 `@tab_routes` 之前：

```
handle /fleeting {
    redir * /fleeting/ permanent
}

handle_path /fleeting/* {
    reverse_proxy 127.0.0.1:3010
}

@legacy_private path_regexp legacy_private ^/private(?:/(.*))?$
handle @legacy_private {
    redir https://liangz77.cn/fleeting/{re.legacy_private.1} 308
}
```

- 旧路径用 **308** 而不是 301：保留方法与请求体，残留标签页里发往 `/private/api/...` 的 POST 也能正确落到新地址
  （301 在部分客户端会被改写成 GET，丢 body）。
- `redir * /fleeting/ permanent` 里的 `*` 不能省：`redir /fleeting/ permanent` 会被 Caddy 当成
  「`/fleeting/` 是匹配器、目标是 `permanent`」，见 `docs/validation-2026-10-07-deploy-private.md` 里的同款踩坑。
- 实际适配结果用 `curl http://127.0.0.1:2019/config/` 核对到：
  `/fleeting` → 301 `/fleeting/`；`/fleeting/*` → `strip_path_prefix:/fleeting` + `reverse_proxy 127.0.0.1:3010`；
  `path_regexp legacy_private` → 308 `https://liangz77.cn/fleeting/{http.regexp.legacy_private.1}`。

服务器流程：备份 `sites-enabled/liangz77.cn.caddy` →（文件名 `/srv/backups/liangz77.cn.caddy.bak-before-fleeting-20261007165410`）
覆盖为 go-sites `Caddyfile` → `caddy validate` 通过 → `systemctl reload caddy`（不重启，其他站点不受影响）。

## 5. 线上验证（公网，2026-10-07）

代码先发布（`deploy/deploy.sh` → 版本 `20261007165400`，`current` 已切换，`fleeting` active，本机 `127.0.0.1:3010/` = 200）。

| 请求 | 结果 |
| --- | --- |
| `GET /private`、`/private/` | **308** → `https://liangz77.cn/fleeting/` |
| `GET /private/app.js` | **308** → `https://liangz77.cn/fleeting/app.js` |
| `GET /private/api/session` | **308** → `https://liangz77.cn/fleeting/api/session` |
| `GET /fleeting` | 301 → `/fleeting/` |
| `GET /fleeting/` | 200，`text/html`，`<title>Fleeting · 随笔</title>`，资源引用为 `favicon.svg` / `style.css` / `app.js` |
| `GET /fleeting/app.js`、`/style.css`、`/favicon.svg` | 200 |
| `GET /fleeting/api/session`、`/api/dates` | 401 JSON |
| `GET /`、`/tools`（主站） | 200，未受影响 |

真实无头 Chrome（390×844 与 1280×900）：

- 直接打开 `https://liangz77.cn/fleeting/`：登录框出现、`--paper` = `#f5f2ea`（样式生效）、
  **没有向站点根发起任何请求**、无 pageerror、无 4xx/5xx（401 除外）；
- 打开 `https://liangz77.cn/private`：最终落在 `/fleeting/`，同上正常；
- `POST /fleeting/api/entries`，`Origin: https://liangz77.cn` → **401 `{"error":"请先登录"}`**（Origin 校验通过、会话校验拦截）；
- `POST /fleeting/api/entries`，`Origin: https://evil.example` → **403**；
- 安全头保持：`Content-Security-Policy`（`default-src 'self'` …）、`Strict-Transport-Security`、
  `X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`。

## 6. 回退

1. 旧路径恢复成代理：`cp -a /srv/backups/liangz77.cn.caddy.bak-before-fleeting-20261007165410 /etc/caddy/sites-enabled/liangz77.cn.caddy && caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy`；
2. 代码回退：`ln -sfn /srv/apps/fleeting/releases/20261007140036 /srv/apps/fleeting/current && systemctl restart fleeting`
   （注意：该版本页面用根绝对路径，在子路径下不可用，只适合配合第 1 步回到 `/private` 反代）。
3. 数据未改动，无需回滚数据。

## 7. 已知边界与未覆盖

- 未在公网做**登录后**的完整人工链路（需要口令；真实口令只存在用户手里），
  登录后的链路由本地子路径回归测试（真实 Chrome + 代理）覆盖。
- 未在公网触发真实模型生成（避免把私人原文发出去，且当前线上库记录本就是迁移过来的私人数据）。
- go-sites 主站 SPA 的「我的」标签仍是 `pushState` 客户端路由（`<button>`），站内点击渲染的是主站自己的旧「我的」页，
  不会跳到 `/fleeting/`；要统一需改 go-sites 前端（未做，等确认）。
- `/private` 的旧链接会永久 308 到新地址，旧书签（含 `/private/app.js` 之类资源路径）都能继续工作。
- 子域 `fleeting.liangz77.cn` 仍未配置（无 DNS A 记录）；若之后要换回子域，
  只需新增站点块并把 `origin` 单值改成新域名（原值改动必须在跳转同时做，否则 POST 全 403）。
