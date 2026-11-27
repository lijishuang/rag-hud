## 🎉 v1.0.0 · 首次公开发布

### 亮点

- **有向数据流可视化**：采集源（网页 / PDF / DB / 工单 / API）→ 向量库环上固定槽位（FNV-1a 哈希稳定映射）→ 检索反向回传查询端
- **零依赖 Canvas 2D 实现**：两层画布合成，流动层只压暗不清屏制造拖尾，锐利层保持线条与文字清晰
- **SSE 直连**：内置 `attachSSE(url, {query, reconnect})`，按约定事件协议接入；后端不可达时自动降级本地模拟
- **会话录制与回放**：`exportSession()` 导出完整 JSON 时间线，`replay(session, {speed, loop, onEnd})` 离线复现问题
- **TypeScript 类型声明**：`hud.d.ts` 覆盖全部 API，支持 IIFE 和打包器
- **性能友好**：流动层 1x、主画布 DPR ≤ 2、`ResizeObserver` 自适应、`prefers-reduced-motion` 自动降级

### API 速览

```js
const hud = RagHud.create(canvas, { slotCount: 96, packetCount: 300 });
hud.attachSSE('/api/rag/stream', { query: '...' });

hud.setStage('retrieve', 0.3);
hud.setCandidates([{ id: 'ch_0481', label: '手册 §3.2 计费规则', score: 0.93 }]);
hud.setHits(hits, { recall: 0.96, latency: 0.42 });

const session = hud.exportSession();
const player  = hud.replay(session, { speed: 1, loop: true });
player.seek(session.ms * 0.6);
```

### 事件协议

| 事件 | 数据 | 视觉反应 |
| --- | --- | --- |
| `stage` | `{name, progress?}` | 阶段条、环进度 |
| `candidates` | `{chunks:[{id,label,score}]}` | 节点云与槽位占用 |
| `hits` | `{chunks:[...], recall?, latency?}` | 命中变绿 |
| `token` | `{text}` | 答案流式输出 |
| `done` | `{tokens?, latency?}` | 收尾 |

### 致谢

基于用户提供的参考图与数据流语义讨论迭代而成。
