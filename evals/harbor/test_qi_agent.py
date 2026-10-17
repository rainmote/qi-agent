"""Offline API contract tests. These do not claim real Harbor integration."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import shutil
import shlex
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


class StubBase:
    def __init__(self, logs_dir, model_name=None, **kwargs):
        self.logs_dir = Path(logs_dir)
        self.model_name = model_name
        self.calls = []

    async def exec_as_root(self, environment, command, **kwargs):
        self.calls.append(("root", command, kwargs))
        return types.SimpleNamespace(stdout="babashka vTEST\n", return_code=0)

    async def exec_as_agent(self, environment, command, **kwargs):
        self.calls.append(("agent", command, kwargs))
        return types.SimpleNamespace(stdout="", return_code=0)


class StubEnvironment:
    default_user = "node"

    def __init__(self):
        self.uploads = {}

    async def upload_dir(self, source_dir, target_dir):
        self.uploads[target_dir] = {file.relative_to(source_dir).as_posix(): file.read_bytes()
                                    for file in Path(source_dir).rglob("*") if file.is_file()}

    async def upload_file(self, source_path, target_path):
        self.uploads[target_path] = Path(source_path).read_bytes()


def load_adapter():
    names = ["harbor", "harbor.agents", "harbor.agents.installed", "harbor.agents.installed.base",
             "harbor.environments", "harbor.environments.base", "harbor.models", "harbor.models.agent",
             "harbor.models.agent.context"]
    modules = {name: types.ModuleType(name) for name in names}
    modules["harbor.agents.installed.base"].BaseInstalledAgent = StubBase
    modules["harbor.agents.installed.base"].with_prompt_template = lambda fn: fn
    modules["harbor.environments.base"].BaseEnvironment = StubEnvironment
    modules["harbor.models.agent.context"].AgentContext = types.SimpleNamespace
    with patch.dict(sys.modules, modules):
        spec = importlib.util.spec_from_file_location("qi_harbor_adapter_test", Path(__file__).with_name("qi_agent.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module


adapter = load_adapter()


class QiAgentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="qi-harbor-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "repo"
        for directory in ("src/qi", "plugins", "evals", ".qi-agent"):
            (self.source / directory).mkdir(parents=True)
        (self.source / "src/qi/cli.clj").write_text("(ns qi.cli)")
        (self.source / "src/qi/.private.edn").write_text("secret")
        (self.source / "evals/solution.clj").write_text("oracle")
        (self.source / ".qi-agent/auth.json").write_text("secret")

    def agent(self, **kwargs):
        options = dict(qi_source_dir=str(self.source), model_name="openai/gpt-test", reasoning_effort="high")
        options.update(kwargs)
        return adapter.QiAgent(logs_dir=self.root / "logs", **options)

    def test_requires_explicit_openai_model_and_effort(self):
        for model in (None, "gpt-test", "anthropic/test"):
            with self.assertRaises(ValueError): self.agent(model_name=model)
        with self.assertRaises(ValueError): self.agent(reasoning_effort="")

    def test_uploads_source_only_and_scoped_fresh_profile(self):
        agent, env = self.agent(), StubEnvironment()
        asyncio.run(agent.install(env))
        self.assertEqual(set(env.uploads[adapter.REMOTE_SOURCE]), {"src/qi/cli.clj"})
        profile = env.uploads[adapter.REMOTE_PROFILE].decode()
        self.assertIn(':model "gpt-test"', profile)
        self.assertIn(':effort "high"', profile)
        self.assertIn(':sandbox :none', profile)
        self.assertNotIn("subagent", profile)
        self.assertEqual(env.uploads[f"{adapter.REMOTE_HOME}/trust.edn"], b'{:roots {"/app" :allow}}\n')
        config = json.loads((agent.logs_dir / "qi-config.json").read_text())
        self.assertEqual(len(config["source_sha256"]), 64)
        self.assertEqual(config["configuration"], "qi-openai-single-agent-v1")

    def test_rejects_source_links(self):
        (self.source / "src/qi/escape.clj").symlink_to(self.source / "evals/solution.clj")
        with self.assertRaisesRegex(ValueError, "symlink"): self.agent()

    def test_run_passes_only_expected_credentials_and_keeps_cost_unknown(self):
        agent, env = self.agent(), StubEnvironment()
        context = types.SimpleNamespace(metadata=None, cost_usd=None, n_input_tokens=None)
        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-key", "OTHER_SECRET": "excluded"}, clear=True):
            asyncio.run(agent.run("Fix it; $(false) ' quoted", env, context))
        kind, command, kwargs = agent.calls[-1]
        self.assertEqual(kind, "agent")
        self.assertEqual(kwargs["cwd"], "/app")
        self.assertNotIn("test-key", command)
        self.assertEqual(shlex.split(command.split(" > /logs/agent/", 1)[0])[-1], "Fix it; $(false) ' quoted")
        self.assertNotIn("OTHER_SECRET", kwargs["env"])
        self.assertIn("qi-output.jsonl", command)
        self.assertIsNone(context.cost_usd)
        self.assertIsNone(context.n_input_tokens)
        self.assertIn("qi", context.metadata)
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, "OPENAI_API_KEY"):
                asyncio.run(agent.run("task", env, context))

    @unittest.skipUnless(shutil.which("bb"), "Babashka unavailable for offline profile boot")
    def test_real_babashka_profile_boot_without_api_calls(self):
        repo = Path(__file__).resolve().parents[2]
        profile = self.root / "profile.edn"
        profile.write_text(adapter.render_profile("gpt-test", "high", workspace=str(self.root)))
        result = subprocess.run([shutil.which("bb"), "--classpath", f"{repo}/src:{repo}/plugins",
                                 "-m", "qi.cli", "--config", str(profile), "--list"],
                                cwd=self.root, env={"PATH": os.environ["PATH"], "HOME": str(self.root),
                                                   "QI_AGENT_HOME": str(self.root / "qi-home")},
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("hash_edit", result.stdout)
        self.assertIn("bash", result.stdout)
        self.assertIn("runtime", result.stdout)


if __name__ == "__main__":
    unittest.main()
