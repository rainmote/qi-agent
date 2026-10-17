import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { ProjectTrustDialog } from "./Dialogs";
import type { ProjectTrust } from "./types";

type TrustRequest = {
  sessionId: string; trust: ProjectTrust; current: () => boolean;
  resolve: (accepted: boolean) => void;
};

/** A trust choice gates dispatch, never just the appearance of the composer. */
export function useProjectTrust() {
  const [status, setStatus] = useState<ProjectTrust | null>(null);
  const [request, setRequest] = useState<TrustRequest | null>(null);
  const pending = useRef<TrustRequest | null>(null);
  const saving = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    pending.current?.resolve(false);
    pending.current = null;
    saving.current = false;
    setRequest(null); setStatus(null); setBusy(false); setError(null);
  };
  useEffect(() => () => { pending.current?.resolve(false); pending.current = null; }, []);

  const check = async (sessionId: string, current: () => boolean, force = false) => {
    const trust = await api.rpc<ProjectTrust>(sessionId, "trust.status");
    if (!current()) return false;
    if (typeof trust?.configured !== "boolean") throw new Error("无法确认项目的信任状态，请更新运行服务后重试。");
    setStatus(trust);
    if (!trust.configured || trust.decision === "allow" || (!force && trust["explicit?"])) return true;
    return new Promise<boolean>(resolve => {
      pending.current?.resolve(false);
      const next = { sessionId, trust, current, resolve };
      pending.current = next; setRequest(next); setError(null);
    });
  };

  const choose = async (decision: "allow" | "deny" | null) => {
    const active = pending.current;
    if (!active || saving.current) return;
    const finish = (accepted: boolean) => {
      if (pending.current !== active) return;
      pending.current = null; setRequest(null); active.resolve(accepted);
    };
    if (decision === null) { finish(false); return; }
    saving.current = true; setBusy(true); setError(null);
    try {
      // A lost response must be reconciled before any second mutation.
      if (api.pendingOperation(active.sessionId)) {
        const outcome = await api.operationStatus(active.sessionId);
        if (!["completed", "failed"].includes(outcome.status)) {
          throw new Error("上次确认的结果尚不明确，请稍后重新核对。");
        }
      }
      if (!active.current() || pending.current !== active) return;
      let trust = await api.rpc<ProjectTrust>(active.sessionId, "trust.status");
      if (trust.mutable !== false && (trust.decision !== decision || !trust["explicit?"])) {
        const result = await api.rpc<{ error?: string }>(active.sessionId, "command.execute", { command: `/trust ${decision}` });
        if (result.error) throw new Error(result.error);
        trust = await api.rpc<ProjectTrust>(active.sessionId, "trust.status");
      }
      if (!active.current() || pending.current !== active) return;
      if (trust.decision !== decision) throw new Error("项目的信任状态未生效，请重试或取消。");
      setStatus(trust); finish(true);
    } catch (failure) {
      if (active.current() && pending.current === active) setError(failure instanceof Error ? failure.message : "无法保存信任选择，请重试。");
    } finally {
      if (pending.current === active || pending.current === null) { saving.current = false; setBusy(false); }
    }
  };

  return { status, setStatus, reset, check,
    dialog: request && <ProjectTrustDialog trust={request.trust} busy={busy} error={error} onChoose={decision => void choose(decision)} /> };
}
