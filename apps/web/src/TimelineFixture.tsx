import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { applyHostEvent, fromSnapshot } from "./projection";
import { Timeline } from "./Timeline";
import { fixtureSnapshot } from "./timeline-fixture-data";
import "./styles.css";

function Fixture() {
  const scroll = useRef<HTMLDivElement>(null);
  const requested = Number(new URLSearchParams(location.search).get("turns") || 2_000);
  const [projection, setProjection] = useState(() => fromSnapshot(fixtureSnapshot(Math.max(1, Math.min(20_000, requested)))));
  const nextSeq = useRef(projection.events.length + 1);
  const [metrics, setMetrics] = useState("");
  const [streaming, setStreaming] = useState(false);
  useEffect(() => {
    const refresh = () => {
      const element = scroll.current;
      const windowElement = element?.querySelector<HTMLElement>("[data-total-rows]");
      setMetrics(`${projection.events.length} events · ${windowElement?.dataset.totalRows || 0} rows · ${element?.querySelectorAll(".timeline-row").length || 0} mounted · scroll ${Math.round(element?.scrollTop || 0)}`);
    };
    refresh();
    const timer = window.setInterval(refresh, 100);
    return () => window.clearInterval(timer);
  }, [projection.events.length]);
  useEffect(() => {
    if (!streaming) return;
    const timer = window.setInterval(() => setProjection((current) => ({ ...current,
      state: { phase: "model", "partial-assistant": String(current.state["partial-assistant"] || "") + "模拟增量输出。\n" },
    })), 80);
    return () => window.clearInterval(timer);
  }, [streaming]);
  const append = () => {
    const seq = nextSeq.current++;
    setProjection((current) => applyHostEvent(current, { hostSeq: seq, version: 1, type: "event", durable: true,
      event_id: `fixture-${seq}`, seq, event: "message", data: { message: { role: "assistant", content: `追加 ${seq}：\n${"追加的模拟内容。\n".repeat(6)}` } } }));
  };
  const insert = () => {
    const seq = nextSeq.current++;
    setProjection((current) => applyHostEvent(current, { hostSeq: seq, version: 1, type: "event", durable: true,
      event_id: `inserted-${seq}`, seq: 0.5, event: "message", data: { message: { role: "assistant", content: "迟到的模拟消息\n".repeat(8) } } }));
  };
  return <main style={{ display: "flex", flexDirection: "column", height: "100dvh", minWidth: 0 }}>
    <header style={{ padding: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <strong>离线长会话测试</strong><button onClick={append}>追加消息</button>
      <button onClick={() => setStreaming((value) => !value)}>{streaming ? "停止输出" : "连续输出"}</button>
      <button onClick={insert}>插入早期消息</button>
      <button onClick={() => { if (scroll.current) scroll.current.scrollTop = 0; }}>到顶部</button>
      <button onClick={() => { if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }}>到底部</button>
      <output id="fixture-metrics" style={{ fontSize: 12, width: "100%" }}>{metrics}</output>
    </header>
    <div className="timeline" ref={scroll} tabIndex={0} aria-label="离线测试会话">
      <Timeline projection={projection} scrollRef={scroll} />
    </div>
  </main>;
}

document.body.dataset.theme = "dark";
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
