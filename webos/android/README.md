# 随行 Android 客户端（APK）

把 Web 端「随行 · 智能游览助手」封装为原生 Android 应用。**WebView 保证与服务端 100% 功能对等**，
原生只做三件 WebView 做不好的事：服务器地址配置与连通性检测、原生定位（局域网 HTTP 下 WebView 不支持
`navigator.geolocation`）、麦克风权限转授（语音输入）。

## 安装包

| 文件 | 说明 |
| --- | --- |
| `dist/android/smart-tour-0.1.0-release.apk` | 正式签名版（39 KB），可直接分发安装 |
| `dist/android/smart-tour-0.1.0-debug.apk` | 调试版（60 KB），带 `WebView` 远程调试，用于排障 |

- 包名：`cn.suixing.tour`（debug 版为 `cn.suixing.tour.debug`，可与正式版共存）
- 版本：0.1.0（versionCode 1）；minSdk 26（Android 8.0）/ targetSdk 34
- 签名：`keystore/suixing.jks`，alias `suixing`，口令 `suixing2026`（**自签名，仅内部使用**；
  上架应用商店需换成正式签名，且换签名后无法覆盖安装旧包）

## 首次使用

1. **先启动服务端**（电脑上）：`node server/index.js`
2. 安装 APK 后打开应用 → 进入「连接服务端」页
3. 填写服务端地址：
   - 手机与电脑同一 Wi-Fi：`http://<电脑局域网IP>:8080`（页面有「本机局域网地址」快捷填入）
   - Android 模拟器：`http://10.0.2.2:8080`
   - 已部署到公网：`https://你的域名`
4. 点「测试连接并保存」→ 显示地图服务/AI 服务状态 → 自动进入应用
5. 右上角 ⚙ 可随时改地址，↻ 重新加载

## 已实测通过（模拟器 Android 14）

用 WebView 远程调试协议驱动的端到端验收（`node scripts/apk-probe.js`，14 项全绿）：

- APK 内正确加载随行应用，原生能力注入成功
- **原生定位桥**返回真实坐标（`adb emu geo fix` 注入的 GPS 坐标），服务端完成一次 WGS84→GCJ02 转换
- 起点弹层 → 使用当前位置 → 定位结果写入条件胶囊
- 一句话「想去人民公园逛逛，两小时，看看有特色的地方，回到起点」→ AI 识别场所 + 高德真实路线
- 高德真实底图与站点渲染正常（WebView 内 AMap JS 可用）
- 会话凭证持久化在 WebView localStorage，重启应用无需重新配置

## 权限与安全

| 权限 | 用途 |
| --- | --- |
| INTERNET / ACCESS_NETWORK_STATE | 访问服务端 |
| ACCESS_FINE/COARSE_LOCATION | 「使用当前位置」（点击时才申请） |
| RECORD_AUDIO | 语音输入（未配置 ASR 时回退为文本输入） |

- 明文 HTTP 已放行（服务端多为局域网自建服务）；**公网部署请改用 HTTPS**，
  并可在 `res/xml/network_security_config.xml` 收敛为按域名白名单。
- 应用不保存账号密码：会话由服务端下发的游客凭证承载，仅本地留存于 WebView 存储。
- 客户端的 WebView 调试仅在 debug 包含开启（`setWebContentsDebuggingEnabled`），release 包关闭。

## 重新构建

```bash
export JAVA_HOME="C:/Program Files/Eclipse Adoptium/jdk-17.0.16.8-hotspot"
cd android
./gradlew assembleDebug assembleRelease     # 产物在 app/build/outputs/apk/
node ../scripts/../tools/...                # 图标重生成：python tools/gen_icons.py
```

技术栈刻意保持最小：**纯 Java + Android 框架原生控件 + AGP 8.7.3，零第三方依赖**（不含 AndroidX/Material），
构建只需 JDK 17 与 Android SDK（compileSdk 34），无需 Kotlin 插件。

## 已知限制

- 需服务端可达：手机与服务器不在同一网络时会提示"连不上"，需公网部署或内网穿透。
- 锁屏/切后台后 WebView 可能暂停 JS，持续定位提示与语音播报会中断（前台助手定位）。
- 模拟器上 10.0.2.2 可能被 Windows 防火墙拦截；稳妥做法是 `adb reverse tcp:8080 tcp:8080` 后用 `http://localhost:8080`（真机不受影响）。
- 骑行功能按产品文档仍为受控未开放状态。
