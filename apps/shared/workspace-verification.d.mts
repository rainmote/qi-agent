export interface VerificationConfig { directory: string; controllerSha: string }
export interface SourceFileFingerprint { file: string; mode: string; sha256: string; object?: string }
export interface WorkspaceVerification { status: "PASS" | "UNKNOWN" | "NOT_RUN" | "VERIFYING" | "FAIL" | "STALE"; reason?: string; candidateId?: string; sourceFingerprint?: string; candidateSha?: string; checkedAt?: string; checks?: Array<{ id: string; status: string; detailsUrl?: string }> }
export function verificationKey(workspacePath: string, turnId: string): string;
export function verificationGit(root: string, args: string[]): Promise<string>;
export function workspaceManifest(root: string, objectFormat?: "sha1" | "sha256"): Promise<SourceFileFingerprint[]>;
export function validateReceiptBindings(receipt: unknown, controllerSha: string): void;
export function readWorkspaceVerification(config: VerificationConfig | undefined, workspacePath: string, changes: { turnId: string; partial: boolean; files: Array<{ path: string; status: string; after: string }> }): Promise<WorkspaceVerification>;
