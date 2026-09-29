# 规划向导返回按钮 + 起终点精确选点（组合拳）

## 改动 1：向导补返回/上一步（问题 1）

**home.js**（webos/web/js/home.js）
- 底部栏（L179-180）：`d.step ≥ 2` 时在主按钮左侧加「上一步」`btn-ghost` 按钮（`.bottom-bar .btn{flex:1}` 已支持并排）。回退目标：step2→1；step3→（venue 场景 ? 2 : wander 直达 1）
- 步骤条（L21-25）：已完成/更早的步骤 dot 加 `onclick=goStep(n)` 可点击回退 + `cursor:pointer`

**plan.js**（次要补充）：页面顶部加轻量「‹ 返回调整条件」按钮 → `location.hash='#/'`（仿 plan.js:363 既有写法，现在只有规划失败时才有返回入口）

## 改动 2：起终点精确到门（问题 2，组合拳）

### 前端 home.js
1. **重写 `openAmapPick` → 组合选点面板**（起点/终点共用）：
   - 搜索框（`GET /v1/places/search`）→ 结果点击落图定位（大致位置）
   - 高德地图 + 已选 marker：点图微调，regeo 显示地址
   - **景区模式叠加大门**：`getVenuePack(d.venueId)` 取 `nodes[type='entrance']` → 地图大门标记（注意 `map.add` 坑）+ 面板内大门 chips；点图距门 <80m 自动吸附写 `entranceId`
   - 确认写入：origin→`{lng,lat,label,source,entranceId?,poiId?}`；endpoint→`{endpointMode:'fixed',endpointPoint,endpointLabel,endpointEntranceId}`；自由点清空残留 id；打开时回显已选值
   - 沿用现有避坑：容器先挂载再建图、显式 340px、cleanupFns destroy
2. **起点菜单**精简为：📡 使用当前位置 + 🔍🗺️ 搜索/地图精确选点（合并组合面板）；`openSearch` 保留给必去/避开
3. **终点入口**：wander 终点 fixed chip、venue 更多条件 fixed chip 均改开组合面板
4. **venue step3 新增主字段「从哪个门出」**（"从哪里出发"之后）：默认"自动挑最顺路的门"（flexible 不变），可选 回到起点 / 顺路结束 / 指定门或位置（→组合面板）；从"更多条件"移除避免重复
5. fixture 的 `openMapPick` 小补：终点吸附门时写 `endpointEntranceId`、自由点清空
6. `buildIntentPayload` 补发 `endpointPoiId`；app.js `defaultDraft` 补字段

### 后端（各 1 行级）
7. `domain.js:218` fixed 分支补读 `entranceId: form.endpointEntranceId || null`（planner.js:226-231 已支持，打通最后一环）
8. `api.js:415` 起点 >1km 自动锚定加跳过条件：已带 `entranceId/poiId` 的精确起点不再被改锚到景区中心

### CSS（app.css 微量）
步骤可点样式；面板复用 input/chips/poi-result/btn 既有样式

## 验证与留痕
- `node scripts/acceptance.js` 24 项回归 + `planner-bench.js` 抽查
- 启 :8080 浏览器实测：上一步回退、起点/终点组合面板选门、吸附、生成路线
- 分 2 个 commit（fix 返回 / feat 精确选点）push 到 ScholarFlow main 留痕