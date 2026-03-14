# 启动说明

## 1. 安装依赖

推荐使用：

```bash
npm exec --yes pnpm@10.6.1 install
```

在启动前，先确认 Node 版本建议为：

```bash
node -v
```

要求至少：

```bash
v20.9.0
```

## 2. 启动前端

```bash
npm.cmd run dev:web
```

## 3. 启动后端

```bash
npm.cmd run dev:api
```

## 4. 环境变量

复制 `.env.example`，按本机情况调整：

- `NEXT_PUBLIC_API_HTTP_URL`
- `NEXT_PUBLIC_API_WS_URL`
- `API_PORT`
- `SQLITE_PATH`
- `REDIS_URL`

## 5. 当前已验证

- 根目录 TypeScript 类型检查通过
- `packages/api` TypeScript 类型检查通过
- `packages/shared` 构建通过
- Fastify 后端可以成功启动并监听 `8787`
- `npm.cmd run dev:api` 可直接启动
- `npm.cmd run dev:web` 可直接启动
- 当前前端默认监听 `http://localhost:3000`

## 6. 当前未完全验证

- 项目已升级到 Next.js 16 修复版本，并取消了对 Node 22 的强制要求
- Fastify + SQLite 现在改成基于 Node 24 内置的 `node:sqlite`
