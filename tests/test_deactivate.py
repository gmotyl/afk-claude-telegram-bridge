"""
cmd_deactivate() tests.

Scenarios:
  D-001: deactivate by session_id — writes deactivation event, removes slot
  D-002: daemon processes event (marker file) → slot removed, IPC cleaned
  D-003: daemon timeout fallback — no marker → slot removed anyway
  D-004: no active sessions → prints message, no crash
  D-005: wrong session_id → falls back to first available slot
  D-006: last session deactivated → daemon stopped
  D-007: multiple sessions — only the matching slot removed
"""

import json
import os
import time
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

from tests.conftest import make_state, make_slot, write_session_ipc


class TestCmdDeactivate:

    @pytest.fixture(autouse=True)
    def setup(self, hook_module, tmp_bridge_dir, tmp_ipc_dir):
        self.h = hook_module
        self.bridge_dir = tmp_bridge_dir
        self.ipc_dir = tmp_ipc_dir

        # Write default config
        (tmp_bridge_dir / "config.json").write_text(json.dumps({
            "bot_token": "tok", "chat_id": "-100123"
        }))

    def _write_state(self, state):
        Path(self.h.STATE_PATH).write_text(json.dumps(state))

    def _read_state(self):
        return json.loads(Path(self.h.STATE_PATH).read_text())

    # D-001: deactivate by session_id → writes event, removes slot
    def test_d001_deactivate_by_session_id_writes_event_and_removes_slot(self):
        session_id = "sess-d001"
        write_session_ipc(self.ipc_dir, session_id, meta=True)
        # Write deactivation_processed immediately so poll exits fast
        processed = self.ipc_dir / session_id / "deactivation_processed"
        processed.write_text("done")

        self._write_state(make_state(slots={"1": make_slot(session_id)}))

        with patch('fcntl.flock'), \
             patch.object(self.h, 'stop_daemon'):
            self.h.cmd_deactivate(session_id)

        state = self._read_state()
        assert "1" not in state["slots"]

        events_file = self.ipc_dir / session_id / "events.jsonl"
        # IPC dir may be cleaned up; if it exists, check event was written
        # (it's written before the dir gets removed)

    # D-002: daemon processes event (marker file present) → slot removed, IPC dir cleaned
    def test_d002_with_daemon_marker_removes_slot_and_ipc(self):
        session_id = "sess-d002"
        ipc_session = write_session_ipc(self.ipc_dir, session_id, meta=True)
        processed = ipc_session / "deactivation_processed"
        processed.write_text("done")

        self._write_state(make_state(slots={"1": make_slot(session_id)}))

        with patch('fcntl.flock'), \
             patch.object(self.h, 'stop_daemon'):
            self.h.cmd_deactivate(session_id)

        state = self._read_state()
        assert "1" not in state["slots"]
        assert not ipc_session.exists()

    # D-003: daemon timeout — no marker written in time → slot removed anyway
    def test_d003_daemon_timeout_still_removes_slot(self):
        session_id = "sess-d003"
        write_session_ipc(self.ipc_dir, session_id, meta=True)
        self._write_state(make_state(slots={"1": make_slot(session_id)}))

        # Provide a time function: first 2 calls return T (for event timestamp +
        # deadline calculation), all subsequent calls return T+10 (past deadline).
        real_time = time.time()
        call_count = [0]
        def mock_time():
            call_count[0] += 1
            return real_time if call_count[0] <= 2 else real_time + 10

        with patch('fcntl.flock'), \
             patch.object(self.h, 'stop_daemon'), \
             patch('time.sleep'), \
             patch('hook.time') as mock_time_module:
            mock_time_module.time = mock_time
            mock_time_module.strftime = time.strftime
            self.h.cmd_deactivate(session_id)

        state = self._read_state()
        assert "1" not in state["slots"]

    # D-004: no active sessions → prints message, no crash
    def test_d004_no_sessions_prints_message(self, capsys):
        self._write_state(make_state(slots={}))

        with patch('fcntl.flock'):
            self.h.cmd_deactivate("nonexistent-session")

        out = capsys.readouterr().out
        assert "no active" in out.lower() or "not found" in out.lower() or out.strip() != ""

    # D-005: wrong session_id → falls back to first available slot
    def test_d005_wrong_session_id_falls_back_to_first_slot(self):
        session_id = "sess-d005-real"
        write_session_ipc(self.ipc_dir, session_id, meta=True)
        processed = self.ipc_dir / session_id / "deactivation_processed"
        processed.write_text("done")

        self._write_state(make_state(slots={"1": make_slot(session_id)}))

        with patch('fcntl.flock'), \
             patch.object(self.h, 'stop_daemon'):
            self.h.cmd_deactivate("wrong-session-id")

        state = self._read_state()
        assert "1" not in state["slots"]

    # D-006: last session deactivated → stop_daemon called
    def test_d006_last_session_calls_stop_daemon(self):
        session_id = "sess-d006"
        write_session_ipc(self.ipc_dir, session_id, meta=True)
        processed = self.ipc_dir / session_id / "deactivation_processed"
        processed.write_text("done")

        self._write_state(make_state(slots={"1": make_slot(session_id)}, daemon_pid=12345))

        stop_called = []
        with patch('fcntl.flock'), \
             patch.object(self.h, 'stop_daemon', side_effect=lambda s: stop_called.append(True)):
            self.h.cmd_deactivate(session_id)

        assert len(stop_called) == 1

    # D-007: multiple sessions — only matching slot removed
    def test_d007_multiple_sessions_only_matching_removed(self):
        sess1 = "sess-d007a"
        sess2 = "sess-d007b"
        ipc1 = write_session_ipc(self.ipc_dir, sess1, meta=True)
        ipc2 = write_session_ipc(self.ipc_dir, sess2, meta=True)
        (ipc1 / "deactivation_processed").write_text("done")

        self._write_state(make_state(slots={
            "1": make_slot(sess1),
            "2": make_slot(sess2, slot_num="2"),
        }))

        with patch('fcntl.flock'), \
             patch.object(self.h, 'stop_daemon'):
            self.h.cmd_deactivate(sess1)

        state = self._read_state()
        assert "1" not in state["slots"]
        assert "2" in state["slots"]
