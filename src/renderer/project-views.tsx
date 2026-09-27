import { useEffect, useId, useRef, useState } from "react";
import type { ProjectionObject } from "../shared/runtime-host";
import { EvidenceReader, type EvidenceCache } from "./project-evidence";
type Node = { id: string; label: string; stateLabel: string; kind?: string };
type Edge = {
  id: string;
  source: string;
  target: string;
  label: string;
  semantics?: string;
};
type TraceEntry = {
  id: string;
  occurredAt: string;
  text: string;
  section?: string;
};
const NODE_W = 220,
  NODE_H = 64,
  GAP_X = 56,
  GAP_Y = 40,
  STACK = 24,
  MARGIN = 24;
/**
 * Levels by the longest path from a source, the members of a level stacked in one slot. KB-319: a long chain
 * as one column fitted a 380 px canvas at about 29 %; the levels now run in rows that turn back at each end
 * (the accepted prototype's flow wraps its stages the same way), about 1.5 times as many rows as slots per
 * row, so fitting the whole graph keeps the node titles readable.
 */
function layout(nodes: Node[], edges: Edge[]) {
  const positions = new Map<string, { x: number; y: number }>(),
    levels = new Map<string, number>();
  const incoming = new Map(nodes.map((n) => [n.id, 0])),
    outgoing = new Map<string, string[]>();
  for (const e of edges) {
    incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1);
    outgoing.set(e.source, [...(outgoing.get(e.source) ?? []), e.target]);
  }
  const queue = nodes.filter((n) => incoming.get(n.id) === 0).map((n) => n.id);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    levels.set(id, levels.get(id) ?? 0);
    for (const target of outgoing.get(id) ?? []) {
      levels.set(
        target,
        Math.max(levels.get(target) ?? 0, levels.get(id)! + 1),
      );
      incoming.set(target, incoming.get(target)! - 1);
      if (incoming.get(target) === 0) queue.push(target);
    }
  }
  const unresolved = nodes.filter((n) => !queue.includes(n.id));
  // Cycles have no topological order. Keep their declared identity, four to a slot after the ordered levels.
  const base = Math.max(-1, ...levels.values()) + 1,
    members: string[][] = [];
  nodes.forEach((n) => {
    const cycle = unresolved.indexOf(n),
      level = cycle < 0 ? levels.get(n.id)! : base + Math.floor(cycle / 4);
    (members[level] ??= []).push(n.id);
  });
  for (let level = 0; level < members.length; level++) members[level] ??= [];
  const slots = Math.max(1, Math.ceil(Math.sqrt(members.length / 1.5)));
  let top = MARGIN;
  for (let row = 0; row * slots < members.length; row++) {
    const band = members.slice(row * slots, (row + 1) * slots);
    band.forEach((ids, i) => {
      const slot = row % 2 ? slots - 1 - i : i;
      ids.forEach((id, k) =>
        positions.set(id, {
          x: MARGIN + slot * (NODE_W + GAP_X),
          y: top + k * (NODE_H + STACK),
        }),
      );
    });
    const tallest = Math.max(1, ...band.map((ids) => ids.length));
    top += tallest * (NODE_H + STACK) - STACK + GAP_Y;
  }
  return positions;
}
/** An edge between two node boxes: side to side along a row, bottom to top between rows, a loop on the right back up a slot. */
const sideBySide = (a: { x: number }, b: { x: number }) =>
  b.x >= a.x + NODE_W || b.x + NODE_W <= a.x;
/** The loop of an edge back up its own slot reaches this far right of the nodes. */
const LOOP = 48;
function route(a: { x: number; y: number }, b: { x: number; y: number }) {
  const midA = a.y + NODE_H / 2,
    midB = b.y + NODE_H / 2;
  if (sideBySide(a, b)) {
    const right = b.x > a.x,
      x1 = right ? a.x + NODE_W : a.x,
      x2 = right ? b.x : b.x + NODE_W,
      d = Math.max(20, Math.abs(x2 - x1) / 2) * (right ? 1 : -1);
    return {
      path: `M ${x1} ${midA} C ${x1 + d} ${midA}, ${x2 - d} ${midB}, ${x2} ${midB}`,
      label: {
        x: (x1 + x2) / 2,
        y: (midA + midB) / 2 - 6,
        anchor: "middle" as const,
      },
    };
  }
  if (b.y >= a.y + NODE_H) {
    const x1 = a.x + NODE_W / 2,
      y1 = a.y + NODE_H,
      x2 = b.x + NODE_W / 2,
      y2 = b.y,
      d = (y2 - y1) / 2;
    return {
      path: `M ${x1} ${y1} C ${x1} ${y1 + d}, ${x2} ${y2 - d}, ${x2} ${y2}`,
      label: {
        x: (x1 + x2) / 2 + 8,
        y: (y1 + y2) / 2 + 4,
        anchor: "start" as const,
      },
    };
  }
  const x1 = a.x + NODE_W,
    x2 = b.x + NODE_W;
  return {
    path: `M ${x1} ${midA} C ${x1 + 60} ${midA}, ${x2 + 60} ${midB}, ${x2} ${midB}`,
    label: {
      x: Math.max(x1, x2) + 50,
      y: (midA + midB) / 2,
      anchor: "start" as const,
    },
  };
}
function Graph({
  object,
  projectId,
}: {
  object: ProjectionObject;
  projectId: string;
}) {
  const nodes = object.view.nodes as Node[],
    edges = object.view.edges as Edge[],
    positions = layout(nodes, edges);
  const key = `project-graph:${projectId}:${object.objectRef}`,
    marker = useId().replaceAll(":", "");
  const initial = () => {
    try {
      const v = JSON.parse(sessionStorage.getItem(key) ?? "null");
      if (
        v &&
        Number.isFinite(v.zoom) &&
        Number.isFinite(v.x) &&
        Number.isFinite(v.y)
      )
        return {
          zoom: Math.max(0.001, Math.min(3, v.zoom)),
          x: v.x as number,
          y: v.y as number,
          node: typeof v.node === "string" ? v.node : "",
        };
    } catch {
      /* invalid local layout is ignored */
    }
    return { zoom: 1, x: 0, y: 0, node: "" };
  };
  const [view, setView] = useState(initial),
    svg = useRef<SVGSVGElement>(null),
    drag = useRef<{
      x: number;
      y: number;
      originX: number;
      originY: number;
    } | null>(null);
  const selected = nodes.find((n) => n.id === view.node);
  function fit() {
    const box = svg.current?.getBoundingClientRect();
    if (!box || !positions.size) return;
    const loops = edges.some((e) => {
      const a = positions.get(e.source),
        b = positions.get(e.target);
      return a && b && !sideBySide(a, b) && b.y < a.y + NODE_H;
    });
    const width =
        Math.max(...[...positions.values()].map((p) => p.x)) +
        NODE_W +
        MARGIN +
        (loops ? LOOP : 0),
      height =
        Math.max(...[...positions.values()].map((p) => p.y)) + NODE_H + MARGIN;
    const zoom = Math.max(
      0.001,
      Math.min(1.3, (box.width - 24) / width, (box.height - 24) / height),
    );
    setView((v) => ({
      ...v,
      zoom,
      x: (box.width - width * zoom) / 2,
      y: (box.height - height * zoom) / 2,
    }));
  }
  function locate(id: string) {
    const p = positions.get(id),
      box = svg.current?.getBoundingClientRect();
    if (p && box)
      setView((v) => ({
        ...v,
        node: id,
        zoom: Math.max(v.zoom, 0.75),
        x: box.width / 2 - (p.x + NODE_W / 2) * Math.max(v.zoom, 0.75),
        y: box.height / 2 - (p.y + NODE_H / 2) * Math.max(v.zoom, 0.75),
      }));
  }
  useEffect(() => {
    if (!sessionStorage.getItem(key)) fit();
  }, [key]);
  useEffect(() => {
    sessionStorage.setItem(key, JSON.stringify(view));
  }, [key, view]);
  if (
    new Set(nodes.map((n) => n.id)).size !== nodes.length ||
    new Set(edges.map((e) => e.id)).size !== edges.length
  )
    return (
      <p role="alert" className="project-error">
        拓扑标识重复，无法准确定位节点与连线。
      </p>
    );
  return (
    <section className="project-graph" aria-label="流程拓扑">
      <div className="project-view-tools">
        <button
          className="button"
          aria-label="缩小拓扑"
          onClick={() =>
            setView((v) => ({ ...v, zoom: Math.max(0.001, v.zoom / 1.25) }))
          }
        >
          −
        </button>
        <output aria-label="拓扑缩放">{Math.round(view.zoom * 100)}%</output>
        <button
          className="button"
          aria-label="放大拓扑"
          onClick={() =>
            setView((v) => ({ ...v, zoom: Math.min(3, v.zoom * 1.25) }))
          }
        >
          +
        </button>
        <button className="button" onClick={fit}>
          适应内容
        </button>
        <select
          aria-label="检查节点"
          value={selected?.id ?? ""}
          onChange={(e) => locate(e.target.value)}
        >
          <option value="">选择节点</option>
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.label} · {n.stateLabel}
            </option>
          ))}
        </select>
        <button
          className="button"
          disabled={!selected}
          onClick={() => locate(selected!.id)}
        >
          定位节点
        </button>
      </div>
      <svg
        ref={svg}
        className="project-graph-canvas"
        role="group"
        aria-label="拓扑画布，可拖动平移"
        tabIndex={0}
        onKeyDown={(e) => {
          const delta: Record<string, [number, number]> = {
            ArrowLeft: [30, 0],
            ArrowRight: [-30, 0],
            ArrowUp: [0, 30],
            ArrowDown: [0, -30],
          };
          if (e.target === e.currentTarget && delta[e.key]) {
            e.preventDefault();
            const [x, y] = delta[e.key];
            setView((v) => ({ ...v, x: v.x + x, y: v.y + y }));
          }
        }}
        onPointerDown={(e) => {
          if (e.button !== 0 || (e.target as Element).closest("[data-node]"))
            return;
          drag.current = {
            x: e.clientX,
            y: e.clientY,
            originX: view.x,
            originY: view.y,
          };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d)
            setView((v) => ({
              ...v,
              x: d.originX + e.clientX - d.x,
              y: d.originY + e.clientY - d.y,
            }));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <defs>
          <marker
            id={marker}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" />
          </marker>
        </defs>
        <g transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
          {edges.map((e) => {
            const a = positions.get(e.source),
              b = positions.get(e.target);
            if (!a || !b) return null;
            const { path, label } = route(a, b);
            return (
              <g key={e.id} className="project-graph-edge">
                <path d={path} markerEnd={`url(#${marker})`} />
                <text x={label.x} y={label.y} textAnchor={label.anchor}>
                  {e.label.slice(0, 28)}
                </text>
                <title>
                  {e.label} {e.semantics}
                </title>
              </g>
            );
          })}
          {nodes.map((n) => {
            const p = positions.get(n.id)!;
            return (
              <g
                key={n.id}
                transform={`translate(${p.x} ${p.y})`}
                data-node={n.id}
                role="button"
                tabIndex={0}
                aria-label={`检查节点 ${n.label}`}
                aria-pressed={selected?.id === n.id}
                className="project-graph-node"
                onClick={() => setView((v) => ({ ...v, node: n.id }))}
                onKeyDown={(e) => {
                  if (["Enter", " "].includes(e.key)) {
                    e.preventDefault();
                    setView((v) => ({ ...v, node: n.id }));
                  }
                }}
              >
                <rect width={NODE_W} height={NODE_H} rx="12" />
                <text x="14" y="25">
                  {n.label.slice(0, 18)}
                </text>
                <text className="project-node-state" x="14" y="47">
                  {n.stateLabel.slice(0, 24)}
                </text>
                <title>
                  {n.label} · {n.stateLabel}
                </title>
              </g>
            );
          })}
        </g>
      </svg>
      {selected && (
        <section className="project-node-detail" aria-label="节点详情">
          <h4>{selected.label}</h4>
          <p>{selected.stateLabel}</p>
          <p className="project-source">
            {selected.id} {selected.kind}
          </p>
          <ul>
            {edges
              .filter(
                (e) => e.source === selected.id || e.target === selected.id,
              )
              .map((e) => (
                <li key={e.id}>
                  {nodes.find((n) => n.id === e.source)?.label} →{" "}
                  {nodes.find((n) => n.id === e.target)?.label} · {e.label}{" "}
                  {e.semantics}
                </li>
              ))}
          </ul>
        </section>
      )}
    </section>
  );
}
function Trace({
  object,
  projectId,
}: {
  object: ProjectionObject;
  projectId: string;
}) {
  const entries = object.view.entries as TraceEntry[],
    sections = [
      ...new Set(entries.flatMap((e) => (e.section ? [e.section] : []))),
    ],
    key = `project-run:${projectId}:${object.objectRef}`;
  const [selection, setSelection] = useState(
    () => sessionStorage.getItem(key) ?? "",
  );
  const chosen = sections.includes(selection) ? selection : "";
  return (
    <section aria-label="Trace 日志">
      <label>
        运行
        <select
          aria-label="选择运行"
          value={chosen}
          onChange={(e) => {
            setSelection(e.target.value);
            sessionStorage.setItem(key, e.target.value);
          }}
        >
          <option value="">全部运行</option>
          {sections.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <ol className="project-trace">
        {entries
          .filter((e) => !chosen || e.section === chosen)
          .map((e) => (
            <li key={e.id}>
              <time>
                {Number.isFinite(Date.parse(e.occurredAt))
                  ? new Date(e.occurredAt).toLocaleString("zh-CN")
                  : e.occurredAt}
              </time>
              <p>{e.text}</p>
              <small>
                {e.section} · {e.id}
              </small>
            </li>
          ))}
      </ol>
      {!entries.length && <p>该运行尚无 Trace 记录。</p>}
    </section>
  );
}
export function ProjectView({
  object,
  projectId,
  cache,
  unavailable,
}: {
  object: ProjectionObject;
  projectId: string;
  cache: EvidenceCache;
  unavailable: string;
}) {
  const shared = { projectId, object, cache, unavailable };
  return (
    <>
      {object.view.kind === "graph" && (
        <Graph key={object.objectRef} object={object} projectId={projectId} />
      )}
      {object.view.kind === "trace" && (
        <Trace key={object.objectRef} object={object} projectId={projectId} />
      )}
      {object.view.kind === "document" && (
        <EvidenceReader
          key={`${object.objectRef}:document`}
          {...shared}
          source={{ kind: "document" }}
          label="文档"
          automatic
        />
      )}
      {object.view.kind === "diff" && (
        <div className="project-diff">
          <EvidenceReader
            key={`${object.objectRef}:before`}
            {...shared}
            source={{ kind: "before" }}
            label="修改前"
            automatic
          />
          <EvidenceReader
            key={`${object.objectRef}:after`}
            {...shared}
            source={{ kind: "after" }}
            label="修改后"
            automatic
          />
        </div>
      )}
      {object.evidence.map((_, index) => (
        <EvidenceReader
          key={`${object.objectRef}:evidence:${index}`}
          {...shared}
          source={{ kind: "evidence", index }}
          label={`产物与依据 ${index + 1}`}
        />
      ))}
    </>
  );
}
