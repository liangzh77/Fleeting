# 部署验证记录：改为 https://liangz77.cn/fleeting/（2026-10-07）

## 0. 起因

用户原要求把应用迁到子域 `fleeting.liangz77.cn`；`fleeting.liangz77.cn` 在阿里云 DNS 没有 A 记录，
服务器上也没有 `aliyun` CLI/凭据，无法代加。用户随即改成路径部署：**应用挂在 `https://liangz77.cn/fleeting/`**，
当时的方案是「旧地址 `/private` 只留跳转」。

> **后续更正（同日 17:02）**：用户明确要求 `/private` 不要跳转 —— 它本来就是 go-sites 自己的「我的」标签页，
> 现在改为在「我的」页的应用列表里加一条指向 `/fleeting/` 的条目。跳转已移除，见 **§8**。
> 下面 §0/§4/§5 中关于 `/private` 308 的描述是当时的临时状态，保留作为过程记录。

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

> 上面的 `@legacy_private` 段落**已在 §8 删除**（`/private` 交回 go-sites 的 `@tab_routes`）。

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
| `GET /private`、`/private/` | **308** → `https://liangz77.cn/fleeting/`（当时的临状态，已在 §8 取消） |
| `GET /private/app.js` | **308** → `https://liangz77.cn/fleeting/app.js`（同上，已取消） |
| `GET /private/api/session` | **308** → `https://liangz77.cn/fleeting/api/session`（同上，已取消） |
| `GET /fleeting` | 301 → `/fleeting/` |
| `GET /fleeting/` | 200，`text/html`，`<title>Fleeting · 随笔</title>`，资源引用为 `favicon.svg` / `style.css` / `app.js` |
| `GET /fleeting/app.js`、`/style.css`、`/favicon.svg` | 200 |
| `GET /fleeting/api/session`、`/api/dates` | 401 JSON |
| `GET /`、`/tools`（主站） | 200，未受影响 |

真实无头 Chrome（390×844 与 1280×900）：

- 直接打开 `https://liangz77.cn/fleeting/`：登录框出现、`--paper` = `#f5f2ea`（样式生效）、
  **没有向站点根发起任何请求**、无 pageerror、无 4xx/5xx（401 除外）；
- 打开 `https://liangz77.cn/private`：当时会落在 `/fleeting/`（该行为已在 §8 取消，现在 `/private` 就是主站「我的」页）；
- `POST /fleeting/api/entries`，`Origin: https://liangz77.cn` → **401 `{"error":"请先登录"}`**（Origin 校验通过、会话校验拦截）；
- `POST /fleeting/api/entries`，`Origin: https://evil.example` → **403**；
- 安全头保持：`Content-Security-Policy`（`default-src 'self'` …）、`Strict-Transport-Security`、
  `X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`。

## 6. 回退

1. 旧路径恢复成代理：`cp -a /srv/backups/liangz77.cn.caddy.bak-before-fleeting-20261007165410 /etc/caddy/sites-enabled/liangz77.cn.caddy && caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy`；
   （若只想回到 §8 的状态：用备份 `/srv/backups/liangz77.cn.caddy.bak-before-private-restore-20261007170220`。）
2. 代码回退：`ln -sfn /srv/apps/fleeting/releases/20261007140036 /srv/apps/fleeting/current && systemctl restart fleeting`
   （注意：该版本页面用根绝对路径，在子路径下不可用，只适合配合第 1 步回到 `/private` 反代）。
3. 数据未改动，无需回滚数据。

## 7. 已知边界与未覆盖

- 未在公网做**登录后**的完整人工链路（需要口令；真实口令只存在用户手里），
  登录后的链路由本地子路径回归测试（真实 Chrome + 代理）覆盖。
- 未在公网触发真实模型生成（避免把私人原文发出去，且当前线上库记录本就是迁移过来的私人数据）。
- go-sites 主站 SPA 的「我的」标签是 `pushState` 客户端路由（`<button>`），站内点击渲染的是主站自己的「我的」页
  —— 这正是 §8 里加应用条目的原因：主站连到 Fleeting 靠的是「我的」页里那条卡片（`target="_blank"`）。
- `/private` 现在是主站自己的「我的」页（200）；`/private/`（带末尾斜杠）仍是 404，与本次改动前的原有行为一致
  （`@tab_routes` 只匹配 `/private`，`/private/*` 落到静态站点没有该目录）。
- 子域 `fleeting.liangz77.cn` 仍未配置（无 DNS A 记录）；若之后要换回子域，
  只需新增站点块并把 `origin` 单值改成新域名（原值改动必须在跳转同时做，否则 POST 全 403）。

## 8. 更正（同日 17:02）：`/private` 不跳转，改为「我的」页里的一条应用

用户要求：**不要让 `https://liangz77.cn/private` 跳到 `/fleeting`**，而是在 `/private` 页面的应用里加一条
指向 `https://liangz77.cn/fleeting` 的条目。

### 8.1 判定：`/private` 是 go-sites 自己的页面

go-sites 前端 `index.html` 里 `pageRouteMap()` 把页面「我的」映射到路径 `private`，`getRoutePageName()`
从 `location.pathname` 解析单段路径还原页面名。所以 `/private` 一直是主站 SPA 的一个正常路由，
本轮把 `/private` 从 `@tab_routes` 移除并加 308 跳转属于**改动了不属于本应用的东西**，现全部回退。

### 8.2 改动

| 仓库 / 文件 | 改动 |
| --- | --- |
| go-sites `Caddyfile` | 删除 `@legacy_private` 308 段落；`@tab_routes` 恢复 `/private`（放回 `/fun` 与 `/demo` 之间，即原位置）。`/fleeting` 的 `handle` + `handle_path` 不动 |
| go-sites `data.js` | 「我的 → 应用」列表末尾新增一条：名称 `随笔`、地址 `https://liangz77.cn/fleeting/`、备注 `中国 \| 直连 \| 免费`、功能说明一句 |
| go-sites `site-version.txt` | `1.0.25` → `1.0.26` |

Caddy 里的新注释说明了为什么 `/private` 不能加跳转，以及主站连到 Fleeting 的正确做法（改 `data.js`）。

### 8.3 发布

- Caddy：备份 `/srv/backups/liangz77.cn.caddy.bak-before-private-restore-20261007170220` →
  安装 go-sites `Caddyfile` → `caddy validate`「Valid configuration」→ `systemctl reload caddy`（active）。
  `curl http://127.0.0.1:2019/config/` 核对：`legacy_private` 已消失，`/fleeting` 的 301 + `strip_path_prefix` 仍在。
- 站点：`/srv/sites/liangz77.cn/releases/20261007-fleeting-entry`（`cp -a` 上一版 + 新 `data.js`/`site-version.txt`），
  `previous` = `20261007-063923`，`current` 指向新目录，`Host: liangz77.cn` 探活通过。

> 踩坑：`chmod 644 -R <release>` 会把**目录**也改成 644（丢掉 `x` 位），Caddy 读任何文件都 403。
> 正确写法是目录 755、文件 644（`find … -type d -exec chmod 755` + `-type f 644`），或用 `install -d/-m`。
> 表现是站点全线 404/403，很容易误判为反代或路由问题。

### 8.4 线上验证（公网）

| 请求 | 结果 |
| --- | --- |
| `GET /private` | **200**，`text/html`，290398B，`<title>AI入口</title>`（go-sites 页面，**不再跳转**） |
| `GET /data.js`（`?v=20260704-resume`） | 200，55214B，md5 与本地 `data.js` 一致，含新增的「随笔」条目 |
| `GET /fleeting` | 301 → `/fleeting/` |
| `GET /fleeting/` | 200，`<title>Fleeting · 随笔</title>` |
| `GET /fleeting/app.js` | 200（25838B） |
| `GET /fleeting/api/session` | 401 JSON |
| `GET /`、`/tools`（主站） | 200，未受影响 |

真实无头 Chrome（1280×900，`https://liangz77.cn/private`）：

- 页面停在 `/private`、标题 `AI入口`，无任何 `/fleeting/` 请求、无 pageerror；
- `window.WEBPAGES_DATA.pages.我的.类型[0].应用` 有 **5** 条，最后一条即「随笔」→ `https://liangz77.cn/fleeting/`；
- 用主站口令登录后，卡片真实渲染出来（`a` 的 `href = https://liangz77.cn/fleeting/`、`target="_blank"`、可见）。

### 8.5 回退

- Caddy：`cp -a /srv/backups/liangz77.cn.caddy.bak-before-private-restore-20261007170220 /etc/caddy/sites-enabled/liangz77.cn.caddy && caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy`
- 站点：`ln -sfn /srv/sites/liangz77.cn/releases/20261007-063923 /srv/sites/liangz77.cn/current`（已完成前的版本，无「随笔」条目）
