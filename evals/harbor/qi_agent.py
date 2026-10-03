"""Single-agent qi baseline for Harbor's pinned BaseInstalledAgent API.

Requires Babashka already installed in the task image. Never copies host auth,
task fixtures, repository settings, or state. Container integration is unverified.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import tempfile

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

HARBOR_SOURCE_COMMIT = "bf991e490394ef9c3250a6db2bc5cbda903cb4c3"
REMOTE_SOURCE = "/installed-agent/qi-src"
REMOTE_HOME = "/installed-agent/qi-home"
REMOTE_PROFILE = "/installed-agent/qi-profile.edn"
PROFILE_LABEL = "qi-openai-single-agent-v1"
SOURCE_EXTENSIONS = {".clj", ".cljs", ".cljc", ".edn", ".md"}


def source_snapshot(source_root: Path) -> dict[str, bytes]:
    """Materialize a source-only snapshot, rejecting links and special files."""
    result: dict[str, bytes] = {}
    for directory in ("src", "plugins"):
        root = source_root / directory
        if root.is_symlink() or not root.is_dir():
            raise ValueError(f"Expected real source directory: {root}")
        for file in sorted(root.rglob("*")):
            relative = file.relative_to(source_root)
            if file.is_symlink():
                raise ValueError(f"Source symlink rejected: {relative}")
            if file.is_dir():
                continue
            if not file.is_file():
                raise ValueError(f"Special source file rejected: {relative}")
            if any(part.startswith(".") for part in relative.parts):
                continue
            if file.suffix in SOURCE_EXTENSIONS:
                result[relative.as_posix()] = file.read_bytes()
    if "src/qi/cli.clj" not in result:
        raise ValueError("qi_source_dir does not contain src/qi/cli.clj")
    return result


def snapshot_sha256(snapshot: dict[str, bytes]) -> str:
    digest = hashlib.sha256()
    for name, content in sorted(snapshot.items()):
        digest.update(f"{name}\0{len(content)}\0".encode())
        digest.update(content)
    return digest.hexdigest()


def render_profile(model: str, effort: str, max_steps: int = 12, workspace: str = "/app") -> str:
    """Container-only profile: Harbor provides isolation; host use is --list only."""
    quoted_model = json.dumps(model)
    quoted_effort = json.dumps(effort)
    quoted_workspace = json.dumps(workspace)
    return f'''{{:plugins
 [{{:ns qi.plugins.session :config {{:path nil :ephemeral true}}}}
  {{:ns qi.plugins.model-registry :config {{:default-provider :openai}}}}
  {{:ns qi.plugins.openai-responses
    :config {{:model {quoted_model} :api-key-env "OPENAI_API_KEY"
              :timeout-ms 180000 :max-retries 0
              :extra-body {{:reasoning {{:effort {quoted_effort}}}}}}}}}
  {{:ns qi.plugins.execution-world
    ;; Harbor's isolated task container is the process isolation boundary.
    :config {{:root {quoted_workspace} :sandbox :none :timeout-ms 30000 :max-output-chars 50000}}}}
  {{:ns qi.plugins.trust :config {{:root {quoted_workspace} :trusted true}}}}
  {{:ns qi.plugins.tools :config {{:max-read-chars 50000}}}}
  {{:ns qi.plugins.omp :config {{:max-file-chars 500000 :max-edits 32}}}}
  {{:ns qi.plugins.approval :config {{:mode :allow}}}}
  {{:ns qi.plugins.policy
    :config {{:trusted-tools ["write" "edit" "hash_edit" "bash"]
              :approval-tools ["write" "edit" "hash_edit" "bash"]}}}}
  {{:ns qi.plugins.runtime :config {{:max-steps {max_steps} :system-prompt-template :omp}}}}]}}
'''


class QiAgent(BaseInstalledAgent):
    """API-key OpenAI Responses baseline; no subagents, REPL, LSP or compaction."""

    @staticmethod
    def name() -> str:
        return "qi-single-agent"

    def __init__(self, *args, qi_source_dir: str, reasoning_effort: str,
                 model_name: str | None = None, max_steps: int = 12, **kwargs):
        if not isinstance(model_name, str) or not re.fullmatch(r"openai/[A-Za-z0-9][A-Za-z0-9_.-]*", model_name):
            raise ValueError("Pass an explicit -m openai/<model>; other providers are unsupported")
        if not re.fullmatch(r"[a-z][a-z0-9_-]*", reasoning_effort or ""):
            raise ValueError("reasoning_effort must be an explicit API-supported effort name")
        if isinstance(max_steps, bool) or not isinstance(max_steps, int) or not 1 <= max_steps <= 100:
            raise ValueError("max_steps must be an integer from 1 to 100")
        source = Path(qi_source_dir).expanduser().resolve()
        self._snapshot = source_snapshot(source)
        self._source_sha256 = snapshot_sha256(self._snapshot)
        self._effort = reasoning_effort
        self._profile = render_profile(model_name.split("/", 1)[1], reasoning_effort, max_steps)
        self._bb_version: str | None = None
        super().__init__(*args, model_name=model_name, **kwargs)

    def version(self) -> str:
        return f"source-sha256:{self._source_sha256}"

    def _metadata(self) -> dict:
        return {
            "configuration": PROFILE_LABEL,
            "product_scope": "single-agent subset; not the default qi product profile",
            "model": self.model_name,
            "reasoning_effort": self._effort,
            "source_sha256": self._source_sha256,
            "profile_sha256": hashlib.sha256(self._profile.encode()).hexdigest(),
            "adapter_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "babashka_version": self._bb_version,
            "harbor_source_commit": HARBOR_SOURCE_COMMIT,
            "cost_accounting": "unknown; raw JSON retained, no pricing inferred",
        }

    async def install(self, environment: BaseEnvironment) -> None:
        # Source-verified methods: exec_as_root/exec_as_agent, upload_dir/upload_file.
        check = await self.exec_as_root(environment, command="command -v bb >/dev/null && bb --version", cwd="/app")
        self._bb_version = (check.stdout or "").strip()
        await self.exec_as_root(environment, command=f"mkdir -p {REMOTE_SOURCE} {REMOTE_HOME} /logs/agent")
        with tempfile.TemporaryDirectory(prefix="qi-harbor-source-") as temporary:
            stage = Path(temporary)
            source = stage / "source"
            for directory in ("src", "plugins"):
                (source / directory).mkdir(parents=True)
            for relative, content in self._snapshot.items():
                target = source / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
            profile = stage / "profile.edn"
            profile.write_text(self._profile)
            trust = stage / "trust.edn"
            trust.write_text('{:roots {"/app" :allow}}\n')
            await environment.upload_dir(source, REMOTE_SOURCE)
            await environment.upload_file(profile, REMOTE_PROFILE)
            await environment.upload_file(trust, f"{REMOTE_HOME}/trust.edn")
        await self.exec_as_root(environment, command=f"chmod -R a+rX {REMOTE_SOURCE}; chmod 644 {REMOTE_PROFILE}; chmod 700 {REMOTE_HOME}; chmod 600 {REMOTE_HOME}/trust.edn")
        if environment.default_user is not None:
            owner = shlex.quote(str(environment.default_user))
            await self.exec_as_root(environment, command=f"chown -R {owner} {REMOTE_HOME} /logs/agent")
        inventory = ["bb", "--classpath", f"{REMOTE_SOURCE}/src:{REMOTE_SOURCE}/plugins",
                     "-m", "qi.cli", "--config", REMOTE_PROFILE, "--list"]
        await self.exec_as_agent(environment,
                                 command=shlex.join(inventory) + " > /logs/agent/qi-inventory.txt",
                                 cwd="/app", env={"QI_AGENT_HOME": REMOTE_HOME, "HOME": REMOTE_HOME})
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        (self.logs_dir / "qi-config.json").write_text(json.dumps(self._metadata(), indent=2) + "\n")

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        api_key = os.environ.get("OPENAI_API_KEY")
        if not api_key:
            raise ValueError("OPENAI_API_KEY is required in the Harbor runner environment; host auth files are never copied")
        context.metadata = {**(context.metadata or {}), "qi": self._metadata()}
        # No usage fields are assigned: partial usage is not complete run cost.
        argv = ["bb", "--classpath", f"{REMOTE_SOURCE}/src:{REMOTE_SOURCE}/plugins",
                "-m", "qi.cli", "--config", REMOTE_PROFILE, "--provider", "openai",
                "--mode", "json", "--once", instruction]
        command = shlex.join(argv) + " > /logs/agent/qi-output.jsonl 2> /logs/agent/qi-stderr.txt"
        await self.exec_as_agent(environment, command=command, cwd="/app", env={
            "OPENAI_API_KEY": api_key,
            "QI_AGENT_HOME": REMOTE_HOME,
            "HOME": REMOTE_HOME,
            "XDG_CONFIG_HOME": f"{REMOTE_HOME}/config",
        })
