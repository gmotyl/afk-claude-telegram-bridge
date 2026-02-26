"""
cmd_hook() tests — the main Claude Code hook entry point.

Scenarios:
  H-001: PermissionRequest — no AFK session → exits silently (no output)
  H-002: PermissionRequest — direct session match → writes event, polls response (allow)
  H-003: PermissionRequest — auto-approve tool → immediate allow response
  H-004: PermissionRequest — response is deny → deny output
  H-005: PermissionRequest — timeout → deny with timeout message
  H-006: Stop event — writes stop event to IPC
  H-007: Notification event — writes notification event, exits immediately
  H-008: Unknown hook event — exits silently
  H-009: No session_id in hook data — exits silently
  H-010: session_id bound via _find_bound_session → routes to bound IPC dir
  H-011: Exactly one unbound slot → auto-bind on first contact
  H-012: Multiple unbound slots → not our session, exit silently
"""

import io
import json
import os
import time
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

from tests.conftest import make_state, make_slot, write_session_ipc


class TestCmdHook:

    @pytest.fixture(autouse=True)
    def setup(self, hook_module, tmp_bridge_dir, tmp_ipc_dir):
        self.h = hook_module
        self.bridge_dir = tmp_bridge_dir
        self.ipc_dir = tmp_ipc_dir
        (tmp_bridge_dir / "config.json").write_text(json.dumps({
            "bot_token": "tok", "chat_id": "-100123"
        }))

    def _write_state(self, state):
        Path(self.h.STATE_PATH).write_text(json.dumps(state))

    def _run_hook(self, event_data):
        """Run cmd_hook() with fake stdin and catch SystemExit."""
        stdin_data = json.dumps(event_data)
        with patch('sys.stdin', io.StringIO(stdin_data)):
            try:
                self.h.cmd_hook()
            except SystemExit:
                pass

    def _write_response_file(self, session_id, event_id, response):
        """Pre-write a response file so poll returns immediately."""
        response_path = self.ipc_dir / session_id / f"response-{event_id}.json"
        response_path.write_text(json.dumps(response))

    # H-001: No AFK session → exits silently
    def test_h001_no_afk_session_exits_silently(self, capsys):
        self._write_state(make_state(slots={}))
        event_data = {
            "session_id": "unknown-session",
            "hook_event_name": "PermissionRequest",
            "tool_name": "Bash",
            "tool_input": {"command": "ls"},
        }
        self._run_hook(event_data)
        out = capsys.readouterr().out
        assert out.strip() == ""

    # H-002: PermissionRequest — direct session match → allow
    def test_h002_permission_request_direct_match_allow(self, capsys):
        session_id = "sess-h002"
        write_session_ipc(self.ipc_dir, session_id, meta=True)
        self._write_state(make_state(slots={"1": make_slot(session_id)}))

        event_data = {
            "session_id": session_id,
            "hook_event_name": "PermissionRequest",
            "tool_name": "Bash",
            "tool_input": {"command": "git status"},
        }

        # Pre-write allow response so poll returns immediately
        # We need to intercept _poll_response and return allow
        with patch.object(self.h, '_poll_response', return_value={"decision": "allow"}):
            with patch('sys.stdin', io.StringIO(json.dumps(event_data))):
                try:
                    self.h.cmd_hook()
                except SystemExit:
                    pass

        out = capsys.readouterr().out
        result = json.loads(out)
        assert result["hookSpecificOutput"]["decision"]["behavior"] == "allow"

        # Event was written to IPC
        events_file = self.ipc_dir / session_id / "events.jsonl"
        assert events_file.exists()
        events = [json.loads(l) for l in events_file.read_text().strip().split("\n")]
        perm_event = next(e for e in events if e["type"] == "permission_request")
        assert perm_event["tool_name"] == "Bash"

    # H-003: PermissionRequest — auto-approve configured tool → immediate allow
    def test_h003_auto_approve_tool_returns_allow_immediately(self, capsys):
        session_id = "sess-h003"
        write_session_ipc(self.ipc_dir, session_id, meta=True)
        self._write_state(make_state(slots={"1": make_slot(session_id)}))
        (self.bridge_dir / "config.json").write_text(json.dumps({
            "bot_token": "tok",
            "chat_id": "-100123",
            "auto_approve_tools": ["Read"],
        }))

        event_data = {
            "session_id": session_id,
            "hook_event_name": "PermissionRequest",
            "tool_name": "Read",
            "tool_input": {"file_path": "/some/file.py"},
        }
        with patch('sys.stdin', io.StringIO(json.dumps(event_data))):
            try:
                self.h.cmd_hook()
            except SystemExit:
                pass

        out = capsys.readouterr().out
        result = json.loads(out)
        assert result["hookSpecificOutput"]["decision"]["behavior"] == "allow"

    # H-004: PermissionRequest — response is deny
    def test_h004_permission_request_deny_response(self, capsys):
        session_id = "sess-h004"
        write_session_ipc(self.ipc_dir, session_id, meta=True)
        self._write_state(make_state(slots={"1": make_slot(session_id)}))

        event_data = {
            "session_id": session_id,
            "hook_event_name": "PermissionRequest",
            "tool_name": "Bash",
            "tool_input": {"command": "rm -rf /"},
        }
        with patch.object(self.h, '_poll_response',
                          return_value={"decision": "deny", "message": "Too dangerous"}):
            with patch('sys.stdin', io.StringIO(json.dumps(event_data))):
                try:
                    self.h.cmd_hook()
                except SystemExit:
                    pass

        out = capsys.readouterr().out
        result = json.loads(out)
        assert result["hookSpecificOutput"]["decision"]["behavior"] == "deny"
        assert "Too dangerous" in result["hookSpecificOutput"]["decision"]["message"]

    # H-005: PermissionRequest — timeout → deny with timeout message
    def test_h005_permission_request_timeout_returns_deny(self, capsys):
        session_id = "sess-h005"
        write_session_ipc(self.ipc_dir, session_id, meta=True)
        self._write_state(make_state(slots={"1": make_slot(session_id)}))

        event_data = {
            "session_id": session_id,
            "hook_event_name": "PermissionRequest",
            "tool_name": "Bash",
            "tool_input": {"command": "sleep 100"},
        }
        with patch.object(self.h, '_poll_response', return_value=None):
            with patch('sys.stdin', io.StringIO(json.dumps(event_data))):
                try:
                    self.h.cmd_hook()
                except SystemExit:
                    pass

        out = capsys.readouterr().out
        result = json.loads(out)
        assert result["hookSpecificOutput"]["decision"]["behavior"] == "deny"
        assert "timed out" in result["hookSpecificOutput"]["decision"]["message"].lower()

    # H-006: Stop event — writes stop event to IPC
    def test_h006_stop_event_writes_to_ipc(self):
        session_id = "sess-h006"
        write_session_ipc(self.ipc_dir, session_id, meta=True)
        self._write_state(make_state(slots={"1": make_slot(session_id)}))

        event_data = {
            "session_id": session_id,
            "hook_event_name": "Stop",
            "last_assistant_message": "I finished the task.",
            "stop_hook_active": False,
        }

        # Patch _poll_response_or_kill to return a kill signal immediately
        with patch.object(self.h, '_poll_response_or_kill',
                          return_value={"_killed": True, "_reason": "test end"}):
            with patch('sys.stdin', io.StringIO(json.dumps(event_data))):
                try:
                    self.h.cmd_hook()
                except SystemExit:
                    pass

        events_file = self.ipc_dir / session_id / "events.jsonl"
        assert events_file.exists()
        events = [json.loads(l) for l in events_file.read_text().strip().split("\n")]
        stop_event = next(e for e in events if e["type"] == "stop")
        assert stop_event["last_message"] == "I finished the task."

    # H-007: Notification event — writes notification event, exits
    def test_h007_notification_event_writes_to_ipc(self):
        session_id = "sess-h007"
        write_session_ipc(self.ipc_dir, session_id, meta=True)
        self._write_state(make_state(slots={"1": make_slot(session_id)}))

        event_data = {
            "session_id": session_id,
            "hook_event_name": "Notification",
            "notification_type": "permission_prompt",
            "message": "Waiting for approval",
            "title": "Claude",
        }
        with patch('sys.stdin', io.StringIO(json.dumps(event_data))):
            try:
                self.h.cmd_hook()
            except SystemExit:
                pass

        events_file = self.ipc_dir / session_id / "events.jsonl"
        assert events_file.exists()
        events = [json.loads(l) for l in events_file.read_text().strip().split("\n")]
        notif = next(e for e in events if e["type"] == "notification")
        assert notif["notification_type"] == "permission_prompt"

    # H-008: Unknown hook event → exits silently
    def test_h008_unknown_hook_event_exits_silently(self, capsys):
        session_id = "sess-h008"
        write_session_ipc(self.ipc_dir, session_id, meta=True)
        self._write_state(make_state(slots={"1": make_slot(session_id)}))

        event_data = {
            "session_id": session_id,
            "hook_event_name": "UserPromptSubmit",
        }
        self._run_hook(event_data)
        out = capsys.readouterr().out
        assert out.strip() == ""

    # H-009: No session_id → exits silently
    def test_h009_no_session_id_exits_silently(self, capsys):
        event_data = {
            "session_id": "",
            "hook_event_name": "PermissionRequest",
        }
        self._run_hook(event_data)
        out = capsys.readouterr().out
        assert out.strip() == ""

    # H-010: session bound via _find_bound_session → routes to bound IPC dir
    def test_h010_bound_session_routes_to_bound_ipc(self, capsys):
        real_session = "real-session-h010"
        claude_session = "claude-session-h010"
        ipc_session = write_session_ipc(self.ipc_dir, real_session, meta=True)
        (ipc_session / "bound_session").write_text(claude_session)

        self._write_state(make_state(slots={"1": make_slot(real_session)}))

        event_data = {
            "session_id": claude_session,
            "hook_event_name": "Notification",
            "notification_type": "idle_prompt",
            "message": "idle",
            "title": "Test",
        }
        with patch('sys.stdin', io.StringIO(json.dumps(event_data))):
            try:
                self.h.cmd_hook()
            except SystemExit:
                pass

        # Notification should have been written to the real session's IPC dir
        events_file = ipc_session / "events.jsonl"
        assert events_file.exists()
        events = [json.loads(l) for l in events_file.read_text().strip().split("\n")]
        assert any(e["type"] == "notification" for e in events)

    # H-011: Exactly one unbound slot → auto-bind on first contact
    def test_h011_one_unbound_slot_auto_binds(self, capsys):
        real_session = "real-session-h011"
        claude_session = "claude-session-h011"
        ipc_session = write_session_ipc(self.ipc_dir, real_session, meta=True)
        # No bound_session file → unbound slot

        self._write_state(make_state(slots={"1": make_slot(real_session)}))

        event_data = {
            "session_id": claude_session,
            "hook_event_name": "Notification",
            "notification_type": "idle_prompt",
            "message": "test",
            "title": "T",
        }
        with patch('sys.stdin', io.StringIO(json.dumps(event_data))):
            try:
                self.h.cmd_hook()
            except SystemExit:
                pass

        # bound_session file should have been created
        bound_file = ipc_session / "bound_session"
        assert bound_file.exists()
        assert bound_file.read_text().strip() == claude_session

        # Notification event should be written to the IPC dir
        events_file = ipc_session / "events.jsonl"
        assert events_file.exists()

    # H-012: Multiple unbound slots → not our session, exit silently
    def test_h012_multiple_unbound_slots_exits_silently(self, capsys):
        sess1 = "real-h012a"
        sess2 = "real-h012b"
        write_session_ipc(self.ipc_dir, sess1, meta=True)
        write_session_ipc(self.ipc_dir, sess2, meta=True)
        # Both unbound

        self._write_state(make_state(slots={
            "1": make_slot(sess1),
            "2": make_slot(sess2, slot_num="2"),
        }))

        event_data = {
            "session_id": "some-random-claude-session",
            "hook_event_name": "Notification",
            "notification_type": "idle_prompt",
            "message": "test",
            "title": "T",
        }
        self._run_hook(event_data)
        out = capsys.readouterr().out
        assert out.strip() == ""
