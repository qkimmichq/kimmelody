# 修改规则 — Kimmelody

> 如果你想扩展或修改 Kimmelody 的行为，参考以下规则。

## 如何新增音乐源
1. 在 `packages/music-api/src/` 下新建文件，实现搜索、获取 URL、获取歌词三个方法
2. 在 `packages/music-api/src/index.js` 中导出新类
3. 在 `packages/server/src/index.js` 中替换 music 实例

## 如何新增 TTS 引擎
1. 在 `packages/server/src/modules/tts.js` 的 `synthesize` 方法中增加分支
2. 在 `VOICE_MAP` 或 `voiceForScene` 中配置音色映射

## 如何新增调度场景
1. 在 `packages/server/src/modules/context.js` 的 `SCENE_APPEND` 中添加场景提示词
2. 在 `packages/server/src/modules/scheduler.js` 的 `DEFAULT_RULES` 中添加定时规则
3. 在 `packages/server/src/modules/tts.js` 的 `VOICE_MAP` 中配置该场景的音色

## 如何新增 API 端点
1. 在 `packages/server/src/api/http.js` 中添加路由
2. 如需实时推送，在 `packages/server/src/api/ws.js` 中增加事件类型

## 如何修改用户界面
- 所有前端文件在 `packages/web/public/`
- HTML 结构在 `index.html`
- 样式在 `style.css`
- 交互逻辑在 `app.js`
