"""
Session binding tests (hook.py).

Scenarios:
  B-001: _find_bound_session — finds IPC dir with matching bound_session file
  B-002: _find_bound_session — returns None when no match
  B-003: _find_bound_session — returns None when IPC dir doesn't exist
  B-004: _find_unbound_slots — returns dirs without bound_session file
  B-005: _find_unbound_slots — excludes bound dirs
  B-006: _find_unbound_slots — returns empty list when IPC dir missing
  B-007: _bind_session — writes session_id to bound_session file
  B-008: send_response_to_telegram — writes response event to IPC
  B-009: send_response_to_telegram — returns False when no active sessions
  B-010: check_pending_telegram_instructions — delivers and removes instruction
  B-011: check_pending_telegram_instructions — returns False when no instruction
"""

import json
import os
from pathlib import Path
from unittest.mock import patch

import pytest

from tests.conftest import make_state, make_slot, write_session_ipc


class TestSessionBinding:

    # B-001: _find_bound_session finds matching IPC dir
    def test_b001_find_bound_session_finds_match(self, hook_module, tmp_ipc_dir):
        session_id = "sess-b001"
        ipc_session = write_session_ipc(tmp_ipc_dir, session_id, meta=True)
        (ipc_session / "bound_session").write_text("other-session-id")

        result = hook_module._find_bound_session("other-session-id")
        assert result == str(ipc_session)

    # B-002: _find_bound_session returns None when no match
    def test_b002_find_bound_session_returns_none_no_match(self, hook_module, tmp_ipc_dir):
        session_id = "sess-b002"
        ipc_session = write_session_ipc(tmp_ipc_dir, session_id, meta=True)
        (ipc_session / "bound_session").write_text("different-session")

        result = hook_module._find_bound_session("nonexistent-session")
        assert result is None

    # B-003: _find_bound_session returns None when IPC dir doesn't exist
    def test_b003_find_bound_session_no_ipc_dir_returns_none(self, hook_module, tmp_bridge_dir):
        # Point IPC to nonexistent dir
        hook_module.IPC_DIR = str(tmp_bridge_dir / "nonexistent")
        result = hook_module._find_bound_session("any-session")
        assert result is None

    # B-004: _find_unbound_slots returns dirs without bound_session
    def test_b004_find_unbound_slots_returns_unbound_dirs(self, hook_module, tmp_ipc_dir):
        sess1 = "sess-b004a"
        sess2 = "sess-b004b"
        ipc1 = write_session_ipc(tmp_ipc_dir, sess1, meta=True)
        ipc2 = write_session_ipc(tmp_ipc_dir, sess2, meta=True)
        # Only sess1 is bound
        (ipc1 / "bound_session").write_text("some-claude-session")

        unbound = hook_module._find_unbound_slots()
        assert str(ipc2) in unbound
        assert str(ipc1) not in unbound

    # B-005: _find_unbound_slots excludes bound dirs
    def test_b005_find_unbound_slots_excludes_bound(self, hook_module, tmp_ipc_dir):
        session_id = "sess-b005"
        ipc_session = write_session_ipc(tmp_ipc_dir, session_id, meta=True)
        (ipc_session / "bound_session").write_text("bound-claude-sess")

        unbound = hook_module._find_unbound_slots()
        assert str(ipc_session) not in unbound

    # B-006: _find_unbound_slots returns empty list when IPC dir missing
    def test_b006_find_unbound_slots_missing_ipc_returns_empty(self, hook_module, tmp_bridge_dir):
        hook_module.IPC_DIR = str(tmp_bridge_dir / "nonexistent")
        result = hook_module._find_unbound_slots()
        assert result == []

    # B-007: _bind_session writes session_id to bound_session file
    def test_b007_bind_session_writes_file(self, hook_module, tmp_ipc_dir):
        session_id = "sess-b007"
        ipc_session = write_session_ipc(tmp_ipc_dir, session_id, meta=True)

        hook_module._bind_session(str(ipc_session), "claude-session-xyz")

        bound_file = ipc_session / "bound_session"
        assert bound_file.exists()
        assert bound_file.read_text().strip() == "claude-session-xyz"


class TestSendResponseToTelegram:

    # B-008: send_response_to_telegram — writes response event to IPC
    def test_b008_writes_response_event(self, hook_module, tmp_bridge_dir, tmp_ipc_dir):
        session_id = "sess-b008"
        write_session_ipc(tmp_ipc_dir, session_id, meta=True)

        state = make_state(slots={"1": make_slot(session_id)})
        Path(hook_module.STATE_PATH).write_text(json.dumps(state))

        result = hook_module.send_response_to_telegram("Hello from Claude")

        assert result is True
        events_file = tmp_ipc_dir / session_id / "events.jsonl"
        assert events_file.exists()
        events = [json.loads(l) for l in events_file.read_text().strip().split("\n")]
        response_event = next(e for e in events if e["type"] == "response")
        assert response_event["text"] == "Hello from Claude"

    # B-009: send_response_to_telegram — returns False when no active sessions
    def test_b009_returns_false_no_active_sessions(self, hook_module):
        state = make_state(slots={})
        Path(hook_module.STATE_PATH).write_text(json.dumps(state))

        result = hook_module.send_response_to_telegram("anything")
        assert result is False


class TestCheckPendingInstructions:

    # B-010: check_pending_telegram_instructions — delivers and removes queued instruction
    def test_b010_delivers_and_removes_queued_instruction(self, hook_module, tmp_bridge_dir, tmp_ipc_dir, capsys):
        session_id = "sess-b010"
        ipc_session = write_session_ipc(tmp_ipc_dir, session_id, meta=True)

        state = make_state(slots={"1": make_slot(session_id)})
        Path(hook_module.STATE_PATH).write_text(json.dumps(state))

        instruction_file = ipc_session / "queued_instruction.json"
        instruction_file.write_text(json.dumps({"instruction": "do the thing"}))

        result = hook_module.check_pending_telegram_instructions()

        assert result is True
        out = capsys.readouterr().out
        assert "do the thing" in out
        assert not instruction_file.exists()

    # B-011: check_pending_telegram_instructions — returns False when no instruction
    def test_b011_returns_false_no_instruction(self, hook_module, tmp_bridge_dir, tmp_ipc_dir):
        session_id = "sess-b011"
        write_session_ipc(tmp_ipc_dir, session_id, meta=True)

        state = make_state(slots={"1": make_slot(session_id)})
        Path(hook_module.STATE_PATH).write_text(json.dumps(state))

        result = hook_module.check_pending_telegram_instructions()
        assert result is False
