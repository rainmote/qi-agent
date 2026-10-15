export interface VerificationConfig { directory: string; controllerSha: string }
export interface SourceFileFingerprint { file: string; mode: string; sha256: string }
export interface WorkspaceVerification { status: "PASS" | "UNKNOWN" | "NOT_RUN"; reason?: string; candidateSha?: string; checkedAt?: string; checks?: Array<{ id: string; status: string }> }
export function verificationKey(workspacePath: string, turnId: string): string;
export function verificationGit(root: string, args: string[]): Promise<string>;
export function workspaceManifest(root: string): Promise<SourceFileFingerprint[]>;
export function validateReceiptBindings(receipt: unknown, controllerSha: string): void;
export function readWorkspaceVerification(config: VerificationConfig | undefined, workspacePath: string, changes: { turnId: string; partial: boolean; files: Array<{ path: string; status: string; after: string }> }): Promise<WorkspaceVerification>;
