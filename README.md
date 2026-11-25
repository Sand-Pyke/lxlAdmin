# LXL 联赛管理平台

独立管理系统，包含 React 前端和 `backend/` 管理 API。当前生产入口为 https://8.133.23.125；域名 `lxladmin.cn` 已配置到同一站点，但公网访问被阿里云未备案页面拦截。管理 API 在管理服务器独立运行，暂时共用原用户系统的 PostgreSQL 和 OSS。数据库表结构仍由原项目维护，此仓库不自动执行生产数据库迁移。

前端使用 React 19、TypeScript、Vite 7、Ant Design 6、React Router 7 和 TanStack Query 5；后端使用 Next.js 15、Prisma 6。构建与运行不依赖同级原仓库。管理会话使用独立 HttpOnly Cookie 和密钥，浏览器不保存密码或令牌到 localStorage。

## 当前范围

- 管理员登录、三级权限、用户审核、段位与账号操作。
- 工作台、常规赛事、报名管理、大屏选人 1.0、对阵和赛事管理。
- 战队赛事列表及管理、商品、冠军币充值、竞猜和赞助管理。
- 93 个原有活跃 API 路径已迁入独立后端，包括管理域逻辑和共享依赖；不包含废弃的选人 auction 2.0。

视频上传和删除、社区管理、报名分路、赛事计费，以及常规赛和战队赛的名单管理都已接入独立后台。用户站的 `/admin` 和旧选人链接会跳转到独立后台，旧管理 API 已退役。

常规赛事删除仅核心管理员可用，并由后端强制校验。用户管理待审核行只展示通过和拒绝，段位重置单独展示。竞猜开盘在弹窗中操作；工作台、用户及竞猜列表采用统一的紧凑布局。

## 本地开发

使用 Node.js 24。在仓库根目录安装前端及后端依赖：

```powershell
npm ci
npm --prefix backend ci
Copy-Item .env.example .env
Copy-Item backend/.env.example backend/.env
```

在 `backend/.env` 填写开发数据库、独立 ADMIN_SESSION_SECRET 及媒体目录，然后在两个终端分别启动：

```powershell
npm run dev:api
```

```powershell
npm run dev
```

前端访问 http://127.0.0.1:5174，默认代理到 http://127.0.0.1:3001。`BACKEND_ORIGIN` 只用于 Vite 服务端代理，不进入浏览器构建。生产模式 Cookie 要求 HTTPS，本地开发模式可以使用 HTTP。开发写操作应使用独立测试数据库。

## 验证

```powershell
npm test
npm run build
npm run test:api
npm run build:api
npm --prefix backend run test:integration
```

后端集成测试创建独立 PostgreSQL 临时集群，覆盖真实 API、审核、钻石+段位、赛事删除权限、充值事务、赞助、CSRF 和媒体 Range，不连接生产库。需要本机 PostgreSQL 二进制，详情见后端文档。

前端浏览器测试用 `npm run test:e2e`，使用本地内存接口和 Chrome；结果位于 `output/`。部分早期用例仍使用旧页面标题及按钮选择器，不能把当前全部浏览器用例视为已通过。竞猜和删除权限的专项用例已适配当前界面。

## 部署与后续更新

完整的生产拓扑、服务器配置、前后端发布命令、健康检查和回退步骤见 [backend/README.md](backend/README.md)。只修改 UI 时发布前端即可；修改 `backend/` 时构建并发布后端。代码可按正常流程提交 GitHub，数据库密码、OSS 密钥及会话密钥仅保存在服务器 `/etc/lxl-admin/backend.env`，不进入仓库。

当前 Nginx 将 `/api/` 和 `/assets/` 转发到本机独立后端。`frontend-current` 和 `backend-current` 分别选择运行版本；数据库通过受限 SSH 隧道连接原服务器。此次部署不迁表、不搬迁数据库内容。

原先直接代理用户站点 API 的文档保留在 [历史部署说明](docs/frontend-proxy-legacy.md)，仅供迁移前版本回退参考。独立后端切换后不要使用旧 `stage-host.sh` 覆盖当前 Nginx 配置。

## 目录

```text
src/             管理前端、API 客户端和权限界面
backend/         独立管理 API、业务服务、Prisma schema 和隔离测试
config/          Vite 开发代理
deploy/          宿主机部署、数据库桥、隧道及回退工具
scripts/         一次性导入工具
tests/           前端单元和浏览器测试
```
