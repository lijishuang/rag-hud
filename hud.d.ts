/**
 * rag-hud.js 类型声明
 *
 * 使用方式一（script 标签，全局变量）：
 *   <script src="hud.js"></script>
 *   const hud = RagHud.create(canvas, { ... });
 *
 * 使用方式二（打包器）：
 *   import { create } from 'rag-hud';
 */

export as namespace RagHud;

/** 一个被召回的片段 / 向量库条目 */
export interface Chunk {
  /** 唯一标识。稳定哈希后决定它在环上的存储槽位 */
  id: string;
  /** 命中时显示在环上的标签，可省略 */
  label?: string;
  /** 相似度分数 0~1，影响线宽、亮度与节点半径 */
  score: number;
}

/** 采集源头（网页抓取、PDF、数据库……），坐标是相对画布的比例 */
export interface Source {
  label: string;
  x: number;
  y: number;
}

export type StageName =
  | 'embed'
  | 'retrieve'
  | 'rerank'
  | 'generate'
  | 'done'
  | 'idle';

export interface HudColors {
  /** 主线条色，'r,g,b' 形式，默认 '232,246,255' */
  ink?: string;
  /** 命中高亮色，'r,g,b' 形式，默认 '50,240,140' */
  accent?: string;
}

export interface HudStats {
  stage: StageName;
  /** 当前候选片段数量 */
  candidates: number;
  /** 重排后命中数量 */
  hits: number;
  /** 展示用：召回阶段为候选数，之后为命中数，未开始时为 '—' */
  topk: number | string;
  /** 展示用，如 '96%' */
  recall: string;
  /** 展示用，如 '0.42s' */
  latency: string;
  tokens: number;
}

export interface HitsMeta {
  recall?: number;
  latency?: number;
}

/** 录制下来的一条事件，t 为相对会话开始的毫秒数 */
export interface SessionEvent {
  t: number;
  kind: 'stage' | 'candidates' | 'hits' | 'token' | 'log' | 'done';
  data: Record<string, unknown>;
}

export interface Session {
  version: number;
  /** 会话总时长（毫秒） */
  ms: number;
  events: SessionEvent[];
}

export interface ReplayOptions {
  /** 播放倍速，默认 1 */
  speed?: number;
  /** 是否循环，默认 false */
  loop?: boolean;
  onEnd?(): void;
}

export interface ReplayHandle {
  play(): void;
  pause(): void;
  stop(): void;
  /** 拖动到指定时间点（毫秒），会先重置再快进 */
  seek(ms: number): void;
  /** 0~1 */
  progress(): number;
}

export interface HudOptions {
  /** 采集源，默认 5 个（网页抓取 / PDF 文档 / 数据库 / 工单系统 / API 推送） */
  sources?: Source[];
  /** 向量库槽位数量，默认 96 */
  slotCount?: number;
  /** 并发在飞的数据包数量，默认 300 */
  packetCount?: number;
  /** 画布内文字字体 */
  font?: string;
  colors?: HudColors;
  /** 强制开启/关闭动效降级，默认跟随 prefers-reduced-motion */
  reducedMotion?: boolean;
  /** 是否自动录制每一轮会话，默认 true */
  record?: boolean;

  onStage?(name: StageName, progress: number): void;
  onStats?(stats: HudStats): void;
  /** 流式答案；done 为 true 表示本次生成结束 */
  onAnswer?(text: string, done: boolean): void;
  onLog?(text: string): void;
}

export interface HudState {
  stage: StageName;
  stageProgress: number;
  candidates: Chunk[];
  hits: Chunk[];
  recall: number;
  latency: number;
  tokens: number;
  answer: string;
  logs: Array<{ text: string; t: number }>;
}

export interface SSEOptions {
  /** 会以 ?q= 的形式拼到 URL 上 */
  query?: string;
  /** 一轮结束后是否自动重连，默认 false */
  reconnect?: boolean;
  /** 重连间隔，默认 3200ms */
  reconnectDelay?: number;
  onStatus?(status: 'live' | 'offline'): void;
  onMeta?(meta: { query?: string; model?: string }): void;
  /** 连接建立失败时回调，通常在这里降级为本地模拟 */
  onFail?(err?: unknown): void;
}

export interface SSEHandle {
  close(): void;
}

export interface RagHudInstance {
  /** 切换阶段；progress 为 0~1，省略时按内置节奏推进 */
  setStage(name: StageName, progress?: number): void;
  /** 召回结果，决定节点云、关系网与槽位占用 */
  setCandidates(chunks: Chunk[]): void;
  /** 重排命中，其余节点被压暗，命中槽位变绿 */
  setHits(chunks: Chunk[], meta?: HitsMeta): void;
  /** 追加一段流式文本 */
  token(text: string): void;
  /** 结束本次生成 */
  done(meta?: { tokens?: number; latency?: number }): void;
  /** 左侧滚动日志 */
  log(text: string): void;
  /** 清空全部状态，进入下一轮 */
  reset(): void;
  /** 开启/关闭录制 */
  record(on?: boolean): void;
  /** 最近一轮完整会话，可直接 JSON 序列化存档 */
  exportSession(): Session | null;
  /** 回放一轮会话；省略 session 时回放最近一轮 */
  replay(session?: Session | null, options?: ReplayOptions): ReplayHandle | null;
  state(): HudState;
  /** 停止渲染并释放 rAF、ResizeObserver 与 SSE 连接 */
  destroy(): void;
  /** 按内置协议绑定 SSE 数据源 */
  attachSSE(url: string, options?: SSEOptions): SSEHandle;
}

export declare function create(
  canvas: HTMLCanvasElement,
  options?: HudOptions
): RagHudInstance;

export declare const version: string;
