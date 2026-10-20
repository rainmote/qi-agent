import { uiText as t } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { ProjectTrustDialog } from "./Dialogs";
import type { ProjectTrust } from "./types";

export type TrustIntent = "enter" | "send" | "manage";
type TrustRequest = {
  sessionId: string; intent: TrustIntent; trust: ProjectTrust | null; current: () => boolean;
  loading: boolean; writing: boolean; error: string | null; readVersion: number;
  result: Promise<boolean>; resolve: (accepted: boolean) => void; reject: (error: unknown) => void;
};

function checkedTrust(trust: ProjectTrust): ProjectTrust {
  if (typeof trust?.configured !== "boolean" || (trust.configured &&
    (typeof trust.root !== "string" || !trust.root.trim() || !["allow", "deny"].includes(trust.decision || "")))) {
    throw new Error(t("无法确认项目的信任状态，请更新运行服务后重试。"));
  }
  return trust;
}
const review = (trust: ProjectTrust) => JSON.stringify([
  trust.configured, trust.root, trust.decision, trust["explicit?"], trust["matched-root"], trust.source, trust.mutable,
]);

/** Trust gates dispatch. Managing it never submits the draft or changes session permissions. */
export function useProjectTrust() {
  const [status, setStatus] = useState<ProjectTrust | null>(null);
  const [request, setRequest] = useState<TrustRequest | null>(null);
  const pending = useRef<TrustRequest | null>(null);
  const saving = useRef<TrustRequest | null>(null);
  const current = (active: TrustRequest) => pending.current === active && active.current();
  const publish = (active: TrustRequest) => { if (current(active)) setRequest({ ...active }); };
  const finish = (active: TrustRequest, accepted: boolean) => {
    if (pending.current !== active) return;
    pending.current = null; setRequest(null); active.resolve(accepted);
  };
  const reset = () => {
    pending.current?.resolve(false); pending.current = null; saving.current = null;
    setRequest(null); setStatus(null);
  };
  useEffect(() => () => { pending.current?.resolve(false); pending.current = null; saving.current = null; }, []);

  const read = async (active: TrustRequest) => {
    const version = ++active.readVersion;
    active.loading = true; active.error = null;
    if (active.intent === "manage" || active.trust) publish(active);
    try {
      const trust = checkedTrust(await api.rpc<ProjectTrust>(active.sessionId, "trust.status"));
      if (!current(active) || active.readVersion !== version) return;
      setStatus(trust); active.trust = trust; active.loading = false;
      if (active.intent !== "manage" && (!trust.configured || trust.decision === "allow" || trust["explicit?"])) {
        finish(active, true); return;
      }
      publish(active);
    } catch (failure) {
      if (!current(active) || active.readVersion !== version) return;
      active.loading = false;
      if (active.intent !== "manage") {
        pending.current = null; setRequest(null); active.reject(failure); return;
      }
      active.error = failure instanceof Error ? failure.message : t("无法读取项目信任状态，请重试。");
      publish(active);
    }
  };

  const check = (sessionId: string, isCurrent: () => boolean, intent: TrustIntent = "send"): Promise<boolean> => {
    if (pending.current?.sessionId === sessionId && current(pending.current)) return pending.current.result;
    pending.current?.resolve(false);
    let resolve!: (accepted: boolean) => void, reject!: (error: unknown) => void;
    const result = new Promise<boolean>((yes, no) => { resolve = yes; reject = no; });
    const next: TrustRequest = { sessionId, intent, trust: null, current: isCurrent, loading: true, writing: false,
      error: null, readVersion: 0, result, resolve, reject };
    pending.current = next;
    if (intent === "manage") publish(next);
    void read(next);
    return result;
  };

  const choose = async (decision: "allow" | "deny" | null) => {
    const active = pending.current;
    if (!active || saving.current === active) return;
    if (decision === null) { finish(active, false); return; }
    if (!current(active) || active.loading || !active.trust?.configured) return;
    const reviewed = active.trust;
    saving.current = active; active.writing = true; active.error = null; publish(active);
    try {
      // Unknown outcomes must be reconciled before any new mutation. Never replay with a fresh identity.
      const operation = api.pendingOperation(active.sessionId);
      let recoveredChoice = false;
      if (operation) {
        const outcome = await api.operationStatus(active.sessionId);
        if (!["completed", "failed"].includes(outcome.status)) throw new Error(t("上次确认的结果尚不明确，请稍后重新核对。"));
        recoveredChoice = outcome.status === "completed" && operation.method === "command.execute"
          && operation.params.command === `/trust ${decision}`;
      }
      if (!current(active)) return;
      let trust = checkedTrust(await api.rpc<ProjectTrust>(active.sessionId, "trust.status"));
      if (!current(active)) return;
      const recoveredStillApplies = trust.decision === decision && trust["explicit?"]
        && trust["matched-root"] === reviewed.root && trust.mutable !== false && trust.source === reviewed.source;
      if (trust.root !== reviewed.root || (recoveredChoice ? !recoveredStillApplies : review(trust) !== review(reviewed))) {
        active.trust = trust; setStatus(trust);
        throw new Error(t("项目信任状态已变化。请查看最新路径和状态，再重新选择。"));
      }
      if (!trust.configured || (trust.mutable === false && trust.decision !== decision)) {
        throw new Error(t("当前配置固定了信任状态，无法在这里修改。"));
      }
      if (trust.mutable !== false && (trust.decision !== decision || !trust["explicit?"])) {
        const result = await api.rpc<{ error?: string }>(active.sessionId, "command.execute", { command: `/trust ${decision}` });
        if (result.error) throw new Error(result.error);
        if (!current(active)) return;
        trust = checkedTrust(await api.rpc<ProjectTrust>(active.sessionId, "trust.status"));
      }
      if (!current(active)) return;
      if (trust.root !== reviewed.root || trust.decision !== decision) throw new Error(t("项目的信任状态未生效，请重试或取消。"));
      setStatus(trust); finish(active, true);
    } catch (failure) {
      if (current(active)) { active.error = failure instanceof Error ? failure.message : t("无法保存信任选择，请重试。"); publish(active); }
    } finally {
      // An old project's completion must not unlock a newer project's request.
      if (saving.current === active) saving.current = null;
      if (current(active)) { active.writing = false; publish(active); }
    }
  };

  return { status, setStatus, reset, check,
    dialog: request && <ProjectTrustDialog trust={request.trust} intent={request.intent} loading={request.loading}
      busy={request.writing} error={request.error} onRetry={() => { const active = pending.current; if (active && !active.writing) void read(active); }}
      onChoose={decision => void choose(decision)} /> };
}
