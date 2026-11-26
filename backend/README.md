# 独立管理后端

Next.js API 服务，默认绑定 `127.0.0.1:3001`。管理站点的 `/api/` 和 `/assets/` 由 Nginx 转发到此服务；浏览器不直接连接用户站点或数据库。

当前与用户站点共用 PostgreSQL 和 OSS。没有复制数据库，也没有修改生产表结构。数据库迁移仍由原 `lxlleague` 项目维护；此项目只运行 Prisma Client 生成，不自动执行迁移、db push 或 seed。

## 开发与验证

使用 Node.js 24。配置单独的开发数据库，勿把开发写操作指向生产库。

```powershell
npm ci
Copy-Item .env.example .env
# 填写自己的开发 DATABASE_URL、ADMIN_SESSION_SECRET 和媒体目录
npm run dev
```

在仓库根目录运行 `npm run dev` 启动前端，其 `BACKEND_ORIGIN` 指向本服务。后端开发模式使用 `lxl_admin_session`；生产使用独立的 `__Host-lxl_admin_session`，要求 HTTPS。用户站点 Cookie 和旧后台 Cookie 均不能用于此服务，切换后需要重新登录。

```powershell
npm test
npm run build
npm run typecheck
npm run test:integration
```

集成测试需要已安装 PostgreSQL，可用 `PG_BIN_DIR` 指定二进制目录。它会在根目录 `output/` 创建临时集群、随机端口和测试账号，忽略外部 DATABASE_URL，测试完成后停止集群。仅在该临时数据库执行 db push。覆盖登录、93 个路由的匿名访问、角色权限、钻石+更新与报名快照、审核、删除赛事、充值事务、赞助管理、CSRF 和媒体范围请求。

## 迁移来源和维护边界

`migration-manifest.json` 记录原仓库提交、导入文件原始哈希和 API 路径。哈希用于记录导入来源，不代表修改后仍与上游完全相同。`../scripts/import-management-backend.mjs` 是一次性导入工具，会拒绝覆盖已有后端。

独立服务保留原业务计算和事务逻辑，当前为源码快照，并非共享运行时包。后续涉及比分结算、账本、竞猜等共用规则的变更，需要同时审查两边实现和数据库兼容性，避免逻辑分叉。管理端的主动差异如下：

- 使用独立会话密钥、Cookie 名和 HMAC 命名空间，仅允许已审核管理员登录及调用受保护接口。
- 中间件校验会话签名、有效期和跨站写请求；各路由继续查询数据库确认角色。
- 二级管理员和核心管理员可以删除待选人的常规赛事。竞猜及积分调整接口仅限核心管理员。
- `match/list`、`sponsors` 和修改自身密码接口增加管理身份校验。
- `/assets/` 由本服务读取 ASSET_DIR 或共用 OSS，支持音视频 Range；文件名、路径和符号链接进行校验。
- 选人仅保留 1.0；废弃的 auction 2.0 API 不导入。依赖前端组件的类型已提取为纯类型。
- 管理商品列表只读，不执行原用户商城的默认商品初始化及历史数据修复，避免两个服务重复维护共享数据。

视频和社区列表通过管理端的只读接口提供。用户站保留各自的浏览接口，管理页面及管理写操作集中在本服务。

## 当前生产拓扑

```text
https://8.133.23.125（lxladmin.cn 已配置，公网目前被未备案提示拦截）
  Nginx -> frontend-current（静态前端）
        -> 127.0.0.1:3001（lxl-admin-backend）
              -> 127.0.0.1:15432（lxl-admin-db-tunnel）
                  -> SSH -> 原服务器 loopback15432 -> DB 容器5432
              -> 共用 OSS / /srv/lxl-assets / /srv/lxl-uploads
```

数据库桥使用原服务器已有应用镜像提供 TCP 转发，独立容器 `lxl-admin-db-bridge`，未重启原应用或数据库。数据库端口只监听两台服务器的回环地址。隧道专用 SSH 密钥限制为该端口转发，不允许执行远程命令。

管理服务器仅 root 可读的 `/etc/lxl-admin/backend.env` 保存 DATABASE_URL、OSS 配置和独立 ADMIN_SESSION_SECRET。切勿提交到 Git、复制到前端环境变量或把内容输出到日志。ASSET_DIR 是静态资源目录快照，后续新增目录素材应同步到管理服务器；上传对象仍使用共用 OSS。

FFMPEG_PATH 指向 `/opt/lxl-ffmpeg/ffmpeg`。宿主机部署使用原应用容器中已安装的 Debian FFmpeg 及其依赖和独立加载器，未替换宿主机库。`deploy/export-ffmpeg-runtime.py` 和 wrapper 记录打包方式；更新时应跟随受维护的软件包版本并重新验证转码。Docker 方式直接安装 Alpine ffmpeg。

## 后续发布

前端修改在根目录构建后上传 dist 内容；后端修改上传源码后在 Linux 构建。密钥只留在服务器配置中，构建不需要生产数据库连接。

```powershell
# 前端
npm ci
npm test
npm run build
tar -czf output/frontend.tar.gz -C dist .
scp output/frontend.tar.gz deploy/stage-frontend-host.sh root@8.133.23.125:/opt/lxlleague-admin/
ssh root@8.133.23.125 'bash /opt/lxlleague-admin/stage-frontend-host.sh /opt/lxlleague-admin/frontend.tar.gz'

# 后端：先通过本地测试和构建
npm --prefix backend ci
npm --prefix backend test
npm --prefix backend run build
npm --prefix backend run test:integration
tar --exclude=node_modules --exclude=.next --exclude=.env --exclude=.env.local --exclude=data -czf output/backend-source.tar.gz -C backend .
scp output/backend-source.tar.gz deploy/stage-backend-host.sh deploy/activate-backend-host.sh root@8.133.23.125:/opt/lxlleague-admin/
ssh root@8.133.23.125 'bash /opt/lxlleague-admin/stage-backend-host.sh /opt/lxlleague-admin/backend-source.tar.gz'
# 使用上一步输出的 runtime 路径
ssh root@8.133.23.125 'bash /opt/lxlleague-admin/activate-backend-host.sh /opt/lxlleague-admin/backend-releases/时间戳/.next/standalone'
```

`activate-backend-host.sh` 在健康检查失败时恢复旧 runtime。更新前记录 `readlink -f /opt/lxlleague-admin/backend-current` 和 `frontend-current` 以便回退。后端密钥无需随每次发布改变，否则会使已有登录失效。

切换完成后不要执行旧 `stage-host.sh` 覆盖 Nginx，否则可能重新指向用户站点 API。首次迁移用的 `cutover-backend.py` 只用于预期的旧配置，不是每次发布步骤。

## 运维与回退

```sh
systemctl status lxl-admin-db-tunnel lxl-admin-backend
curl --fail http://127.0.0.1:3001/healthz
curl --fail http://127.0.0.1:3001/api/health
journalctl -u lxl-admin-backend -n 50 --no-pager
```

`/healthz` 表示进程可响应，`/api/health` 还会读取数据库。配置预检在 backend release 源码目录运行 `node scripts/check-runtime.mjs /etc/lxl-admin/backend.env`，只读、不执行迁移。禁止打印 backend.env。

可用 `node scripts/smoke-runtime.mjs /etc/lxl-admin/backend.env` 验证公网 HTTPS、主要只读 API、匿名拒绝和媒体请求。该检查仅在服务器内存中生成短期管理会话，不验证管理员输入的密码，也不重置密码；真实密码登录由隔离集成测试覆盖，生产仍使用现有账号密码。

仅回退后端版本时重新激活之前的 runtime；仅回退前端时把 frontend-current 指向之前目录。旧用户站 API 已退役，早期 Nginx 代理备份只适用于连同旧用户站镜像一起恢复的场景。回退版本不会恢复已变化的业务数据。

PostgreSQL 表结构迁移仍由用户站仓库维护，用户服务继续提供登录、报名、竞猜、商城、视频播放等功能。
