# F040 · 手机装 Multi-Agent（PWA + 私有组网指引）

> D18 拍板：PWA 小孙自用，**不做多用户认证、不对外分发**。
> 没有登录墙 ⇒ **绝对不能把端口暴露到公网**（端口映射/花生壳公网穿透/云服务器反代都不行——
> 谁扫到端口谁就是「小孙」，能看全部会话、能指挥全部 agent）。手机要用，走**私有组网**：
> 流量在你自己设备之间加密直连，公网上没有入口。

## 一、装 Tailscale（推荐，WireGuard 加密，免费个人版够用）

1. **PC（跑 Multi-Agent 这台）**：https://tailscale.com/download 装 Windows 版 → 登录（Google/微软/GitHub 账号任一）。
2. **iPhone**：App Store 装 Tailscale → 登录**同一账号** → 开启 VPN 开关。
3. PC 上任务栏 Tailscale 图标 → 看本机 IP（`100.x.y.z` 形态，**设备绑定长期不变**）。
4. 手机 Safari 访问 `http://100.x.y.z:3000` —— 能打开 UI 即通。

> 国内备选：蒲公英（Oray）PC + iOS 各装一个，绑同账号组网，拿到虚拟 IP 后同理。
> Tailscale 直连不通时走中继（DERP）会慢一些，但可用。

## 二、配 API 地址（一次性，必做）

前端在浏览器里直连 API（HTTP :8787 + WS），默认指 `localhost` ——
**手机上 localhost 是手机自己**，不配这步 UI 打得开但数据全空/一直转圈。

`.env`（仓库根）加两行（IP 换成上一步的 100.x.y.z）：

```env
NEXT_PUBLIC_API_HTTP_URL=http://100.x.y.z:8787
NEXT_PUBLIC_API_WS_URL=ws://100.x.y.z:8787/ws
```

然后 **stop-project → start-project 重启**（`NEXT_PUBLIC_*` 是构建期注入，改了必须重启 next——
老坑见 feedback：worktree-env-restart-next）。

> 桌面浏览器不受影响：Tailscale 装在本机后，`100.x.y.z` 从本机访问也通（loopback）。
> 若某天想拆 Tailscale，删掉这两行重启即可回 localhost。

## 三、添加到主屏幕（iPhone）

1. Safari 打开 `http://100.x.y.z:3000`。
2. 分享按钮（□↑）→「**添加到主屏幕**」→ 命名 Multi-Agent → 添加。
3. 主屏出现深褐底三金点图标；点开是**独立全屏窗口**（无 Safari 地址栏，manifest `display: standalone`）。

## 四、安全边界（为什么这样是安全的）

| 面 | 说明 |
|---|---|
| 公网零入口 | 3000/8787 只监听本机/内网；Tailscale 流量走 WireGuard 端到端加密，设备准入=你的账号登录 |
| 谁能连 | 只有你 Tailscale 账号下的设备（PC/手机）；踢设备在 Tailscale 控制台 |
| 不做的事 | 端口映射、公网 HTTPS 反代、frp/花生壳公网穿透——任何「给它一个公网地址」的方案都等于把无锁的门挂到大街上 |
| 飞书通道不受影响 | 飞书走 WS 长连接**出站**到飞书服务器，不需要入站端口，与本指引无关 |
