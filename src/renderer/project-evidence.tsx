import { useEffect, useRef, useState } from "react";
import type { EvidenceSource } from "../shared/project-evidence";
import type { ProjectionObject } from "../shared/runtime-host";
export type EvidenceRead = {
  evidence: Record<string, unknown>;
  text: string;
  revision: string;
};
export type EvidenceCache = Map<string, EvidenceRead>;
export function EvidenceReader({
  projectId,
  object,
  source,
  label,
  cache,
  automatic = false,
  unavailable,
}: {
  projectId: string;
  object: ProjectionObject;
  source: EvidenceSource;
  label: string;
  cache: EvidenceCache;
  automatic?: boolean;
  unavailable: string;
}) {
  const key = `${projectId}|${object.objectRef}|${source.kind}|${source.kind === "evidence" ? source.index : ""}`;
  const [value, setValue] = useState<EvidenceRead | undefined>(() =>
      cache.get(key),
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const scroll = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const top = Number(
      sessionStorage.getItem(`project-evidence-scroll:${key}`),
    );
    if (scroll.current && Number.isFinite(top))
      scroll.current.scrollTop = Math.max(0, top);
  }, [key, value?.evidence.digest]);
  const request = useRef(0),
    mounted = useRef(true);
  async function read() {
    const seq = ++request.current;
    setBusy(true);
    setError("");
    try {
      const r = await window.desktop.projectEvidence({
        projectId,
        objectRef: object.objectRef,
        revision: object.revision,
        source,
      });
      if (!mounted.current || seq !== request.current) return;
      if (!r.ok) setError(r.message);
      else {
        const next = {
          evidence: r.evidence,
          text: r.text,
          revision: object.revision,
        };
        cache.set(key, next);
        setValue(next);
      }
    } catch {
      if (mounted.current && seq === request.current)
        setError("读取失败，上一内容已保留。");
    } finally {
      if (mounted.current && seq === request.current) setBusy(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current++;
    };
  }, []);
  useEffect(() => {
    request.current++;
    setBusy(false);
    setError("");
    setValue(cache.get(key));
    if (automatic && !unavailable) void read();
  }, [key, object.revision, automatic, unavailable]);
  return (
    <section className="project-evidence-reader" aria-label={label}>
      <div className="project-section-heading">
        <h4>{label}</h4>
        <button
          className="button"
          disabled={busy || !!unavailable}
          onClick={() => void read()}
        >
          {busy ? "正在读取…" : "读取"}
        </button>
      </div>
      {error && (
        <p role="alert" className="project-error">
          {error}
        </p>
      )}
      {value ? (
        <>
          <p className="project-source">
            已读取：{String(value.evidence.objectRef)} ·{" "}
            {String(value.evidence.revision)} ·{" "}
            {String(value.evidence.mediaType)}
          </p>
          {value.revision !== object.revision && (
            <p role="status">当前对象版本已变化，下面保留上次读取的内容。</p>
          )}
          {value.evidence.mediaType === "text/html" && (
            <p className="project-form-hint">HTML 源码，只读显示。</p>
          )}
          <pre
            ref={scroll}
            onScroll={(e) =>
              sessionStorage.setItem(
                `project-evidence-scroll:${key}`,
                String(e.currentTarget.scrollTop),
              )
            }
            className="project-evidence-text"
            tabIndex={0}
            aria-label={`${label}内容`}
          >
            {value.text}
          </pre>
          <details>
            <summary>证据身份</summary>
            <p className="project-source">
              {String(value.evidence.authority)} ·{" "}
              {String(value.evidence.scopeRef)} ·{" "}
              {String(value.evidence.digest)}
            </p>
          </details>
        </>
      ) : (
        <p className="project-form-hint">
          {busy ? "正在读取固定版本…" : "尚未读取。"}
        </p>
      )}
    </section>
  );
}
