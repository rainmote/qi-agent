"""Pure real-PTY harness receipt validation; no process or filesystem actions."""
def cleanup_receipt_matches(result, expected, exit_code):
    groups = result.get("registered_groups") if isinstance(result, dict) else None
    return bool(type(exit_code) is int and exit_code == 0 and isinstance(result, dict) and isinstance(expected, dict)
                and all(result.get(key) == expected.get(key) and expected.get(key) is not None
                        for key in ("generation", "child_pid", "guardian_pid"))
                and result.get("status") == "closed"
                and result.get("cleanup_confirmed") is True
                and result.get("cleanup_observed") is True
                and result.get("shell_exit_observed") is True
                and result.get("cleanup_scope") == "registered-process-groups"
                and result.get("cleanup_mode") == "native-process-group"
                and isinstance(groups, list) and groups and all(type(g) is int and g > 1 for g in groups)
                and len(set(groups)) == len(groups) and expected.get("child_pid") in groups
                and result.get("descendant_containment") is False)
