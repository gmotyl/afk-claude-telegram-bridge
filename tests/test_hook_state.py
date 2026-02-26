"""
Groups 1-3: State management tests.
  Group 1: is_slot_actually_active() — T-001 to T-008
  Group 2: cleanup_stale_slots()     — T-009 to T-012
  Group 3: cmd_activate()            — T-013 to T-019
"""

import json
import os
import time
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

from tests.conftest import (
    make_state, make_slot, write_session_ipc, make_bridge_daemon
)


# ─── Group 1: is_slot_actually_active() ──────────────────────────────────────

class TestIsSlotActuallyActive:

    def _call(self, hook_module, state, slot_num, current_time=None):
        return hook_module.is_slot_actually_active(state, slot_num, current_time)

    # T-001: slot key missing → False
    def test_t001_slot_missing_returns_false(self, hook_module):
        state = make_state(slots={})
        active, reason = self._call(hook_module, state, "1")
        assert active is False
        assert reason == "slot_not_in_state"

    # T-002: session_id is None → False
    def test_t002_session_id_none_returns_false(self, hook_module, tmp_ipc_dir):
        state = make_state(slots={"1": {"session_id": None}})
        active, reason = self._call(hook_module, state, "1")
        assert active is False
        assert reason == "session_id_missing"

    # T-003: IPC dir missing → False
    def test_t003_ipc_dir_missing_returns_false(self, hook_module):
        session_id = "abc123"
        state = make_state(slots={"1": make_slot(session_id)})
        # Don't create IPC dir
        active, reason = self._call(hook_module, state, "1")
        assert active is False
        assert reason == "ipc_dir_missing"

    # T-004: meta.json missing → False
    def test_t004_meta_missing_returns_false(self, hook_module, tmp_ipc_dir):
        session_id = "abc123"
        # Create IPC dir but no meta.json
        (Path(str(tmp_ipc_dir)) / session_id).mkdir()
        state = make_state(slots={"1": make_slot(session_id)})
        active, reason = self._call(hook_module, state, "1")
        assert active is False
        assert reason == "meta_missing"

    # T-005: kill file present → False
    def test_t005_kill_file_present_returns_false(self, hook_module, tmp_ipc_dir):
        session_id = "abc123"
        write_session_ipc(tmp_ipc_dir, session_id, meta=True, kill=True)
        state = make_state(slots={"1": make_slot(session_id)})
        active, reason = self._call(hook_module, state, "1")
        assert active is False
        assert reason == "kill_file_present"

    # T-006: daemon dead + heartbeat >90s → False
    def test_t006_daemon_dead_stale_heartbeat_returns_false(self, hook_module, tmp_ipc_dir):
        session_id = "abc123"
        write_session_ipc(tmp_ipc_dir, session_id, meta=True)
        old_heartbeat = time.time() - 120  # 120s ago
        state = make_state(slots={"1": make_slot(session_id)},
                           daemon_pid=99999,
                           daemon_heartbeat=old_heartbeat)
        current_time = time.time()
        with patch.object(hook_module, 'is_daemon_alive', return_value=False):
            active, reason = self._call(hook_module, state, "1", current_time)
        assert active is False
        assert reason == "daemon_dead"

    # T-007: daemon alive + IPC + meta + no kill → True
    def test_t007_all_conditions_met_returns_true(self, hook_module, tmp_ipc_dir):
        session_id = "abc123"
        write_session_ipc(tmp_ipc_dir, session_id, meta=True)
        state = make_state(slots={"1": make_slot(session_id)},
                           daemon_pid=12345)
        with patch.object(hook_module, 'is_daemon_alive', return_value=True):
            active, reason = self._call(hook_module, state, "1")
        assert active is True
        assert reason is None

    # T-008: daemon dead but heartbeat <30s → True (still initializing)
    def test_t008_daemon_dead_fresh_heartbeat_returns_true(self, hook_module, tmp_ipc_dir):
        session_id = "abc123"
        write_session_ipc(tmp_ipc_dir, session_id, meta=True)
        recent_heartbeat = time.time() - 10  # 10s ago (fresh)
        state = make_state(slots={"1": make_slot(session_id)},
                           daemon_pid=99999,
                           daemon_heartbeat=recent_heartbeat)
        current_time = time.time()
        with patch.object(hook_module, 'is_daemon_alive', return_value=False):
            active, reason = self._call(hook_module, state, "1", current_time)
        assert active is True


# ─── Group 2: cleanup_stale_slots() ──────────────────────────────────────────

class TestCleanupStaleSlots:

    # T-009: stale slots removed from state
    def test_t009_stale_slots_removed_from_state(self, hook_module, tmp_ipc_dir):
        session_id = "stale001"
        state = make_state(slots={"1": make_slot(session_id)})
        # No IPC dir → stale
        hook_module.cleanup_stale_slots(state)
        assert "1" not in state["slots"]

    # T-010: IPC dirs deleted for stale slots
    def test_t010_ipc_dirs_deleted_for_stale_slots(self, hook_module, tmp_ipc_dir):
        session_id = "stale002"
        ipc_session = write_session_ipc(tmp_ipc_dir, session_id, meta=True)
        # Create with kill file (stale)
        (ipc_session / "kill").write_text("done")
        state = make_state(slots={"1": make_slot(session_id)})
        with patch.object(hook_module, 'is_daemon_alive', return_value=False):
            hook_module.cleanup_stale_slots(state, preserve_ipc_dirs=False)
        assert not ipc_session.exists()

    # T-011: active slots untouched
    def test_t011_active_slots_untouched(self, hook_module, tmp_ipc_dir):
        session_id = "active001"
        write_session_ipc(tmp_ipc_dir, session_id, meta=True)
        state = make_state(slots={"1": make_slot(session_id)},
                           daemon_pid=12345)
        with patch.object(hook_module, 'is_daemon_alive', return_value=True):
            cleaned = hook_module.cleanup_stale_slots(state)
        assert "1" in state["slots"]
        assert cleaned == []

    # T-012: empty slots dict handled safely
    def test_t012_empty_slots_handled_safely(self, hook_module):
        state = make_state(slots={})
        cleaned = hook_module.cleanup_stale_slots(state)
        assert cleaned == []
        assert state["slots"] == {}


# ─── Group 3: cmd_activate() ─────────────────────────────────────────────────

class TestCmdActivate:

    def _write_config(self, hook_module):
        os.makedirs(os.path.dirname(hook_module.CONFIG_PATH), exist_ok=True)
        with open(hook_module.CONFIG_PATH, "w") as f:
            json.dump({"bot_token": "test-token", "chat_id": "-100123"}, f)

    def _write_state(self, hook_module, state):
        os.makedirs(os.path.dirname(hook_module.STATE_PATH), exist_ok=True)
        with open(hook_module.STATE_PATH, "w") as f:
            json.dump(state, f)

    def _read_state(self, hook_module):
        with open(hook_module.STATE_PATH) as f:
            return json.load(f)

    # T-013: fresh activation creates slot + IPC dir + meta.json
    def test_t013_fresh_activation_creates_slot_and_ipc(self, hook_module):
        self._write_config(hook_module)
        self._write_state(hook_module, make_state())
        session_id = "sess-fresh-001"

        with patch.object(hook_module, 'start_daemon', return_value=9999), \
             patch.object(hook_module, 'is_daemon_alive', return_value=False), \
             patch('fcntl.flock'), \
             patch('builtins.open', wraps=open):  # allow real file ops
            hook_module.cmd_activate(session_id, "myproject")

        state = self._read_state(hook_module)
        assert any(
            info.get("session_id") == session_id
            for info in state["slots"].values()
        )
        ipc_session_dir = Path(hook_module.IPC_DIR) / session_id
        assert ipc_session_dir.exists()
        assert (ipc_session_dir / "meta.json").exists()

    # T-014: starts daemon when not running
    def test_t014_starts_daemon_when_not_running(self, hook_module):
        self._write_config(hook_module)
        self._write_state(hook_module, make_state())
        session_id = "sess-daemon-014"
        start_daemon_called = []

        def mock_start():
            start_daemon_called.append(True)
            return 1234

        with patch.object(hook_module, 'start_daemon', side_effect=mock_start), \
             patch.object(hook_module, 'is_daemon_alive', return_value=False), \
             patch('fcntl.flock'):
            hook_module.cmd_activate(session_id, "myproject")

        assert len(start_daemon_called) == 1

    # T-015: same session_id already active → idempotent return
    def test_t015_same_session_already_active_is_idempotent(self, hook_module, tmp_ipc_dir, capsys):
        self._write_config(hook_module)
        session_id = "sess-idem-015"
        write_session_ipc(tmp_ipc_dir, session_id, meta=True)
        existing_state = make_state(
            slots={"1": make_slot(session_id)},
            daemon_pid=12345
        )
        self._write_state(hook_module, existing_state)

        with patch.object(hook_module, 'is_daemon_alive', return_value=True), \
             patch('fcntl.flock'):
            hook_module.cmd_activate(session_id, "myproject")

        out = capsys.readouterr().out
        assert "already active" in out

    # T-016: reattach — new session_id finds old IPC via matching project+topic
    def test_t016_reattach_finds_old_ipc_and_carries_thread_id(self, hook_module, tmp_ipc_dir):
        self._write_config(hook_module)
        old_session = "sess-old-016"
        new_session = "sess-new-016"
        project = "myproject"
        topic_name = "S1 - myproject"
        thread_id = 5555

        # Old session IPC exists, no kill file — looks "active" to cleanup
        # (daemon was alive, user Ctrl+C'd Claude but daemon is still running)
        write_session_ipc(tmp_ipc_dir, old_session, meta=True, kill=False)
        old_state = make_state(
            slots={"1": {**make_slot(old_session, project=project, topic_name=topic_name),
                         "thread_id": thread_id}},
            daemon_pid=12345,
            daemon_heartbeat=time.time()
        )
        self._write_state(hook_module, old_state)

        # Daemon appears alive → old slot survives cleanup_stale_slots
        # Then reattach code finds same project+topic with different session_id
        with patch.object(hook_module, 'start_daemon', return_value=1234), \
             patch.object(hook_module, 'is_daemon_alive', return_value=True), \
             patch('fcntl.flock'):
            hook_module.cmd_activate(new_session, project, topic_name)

        # Check activation event was written with reuse_thread_id
        ipc_new = Path(hook_module.IPC_DIR) / new_session
        events_file = ipc_new / "events.jsonl"
        assert events_file.exists()
        events = [json.loads(l) for l in events_file.read_text().strip().split("\n")]
        activation = next(e for e in events if e["type"] == "activation")
        assert activation.get("reuse_thread_id") == thread_id

    # T-017: thread_id carried forward in activation event
    def test_t017_thread_id_in_activation_event_when_reattaching(self, hook_module, tmp_ipc_dir):
        self._write_config(hook_module)
        old_session = "sess-old-017"
        new_session = "sess-new-017"
        thread_id = 7777

        # No kill file — daemon was alive (separate process), old slot looks active
        write_session_ipc(tmp_ipc_dir, old_session, meta=True, kill=False)
        old_state = make_state(
            slots={"1": {**make_slot(old_session, project="proj", topic_name="S1 - proj"),
                         "thread_id": thread_id}},
            daemon_pid=12345,
            daemon_heartbeat=time.time()
        )
        self._write_state(hook_module, old_state)

        with patch.object(hook_module, 'start_daemon', return_value=1234), \
             patch.object(hook_module, 'is_daemon_alive', return_value=True), \
             patch('fcntl.flock'):
            hook_module.cmd_activate(new_session, "proj", "S1 - proj")

        ipc_new = Path(hook_module.IPC_DIR) / new_session
        events = [json.loads(l) for l in (ipc_new / "events.jsonl").read_text().strip().split("\n")]
        activation = next(e for e in events if e["type"] == "activation")
        assert activation["reuse_thread_id"] == thread_id

    # T-018: stale cleanup runs before slot assignment (prevents full-slots error)
    def test_t018_stale_cleanup_before_slot_assignment(self, hook_module, tmp_ipc_dir):
        self._write_config(hook_module)
        # Fill all 4 slots with stale sessions (no IPC dirs)
        slots = {str(i): make_slot(f"stale-{i}") for i in range(1, 5)}
        self._write_state(hook_module, make_state(slots=slots, daemon_pid=99999))
        new_session = "sess-fresh-018"

        with patch.object(hook_module, 'start_daemon', return_value=1234), \
             patch.object(hook_module, 'is_daemon_alive', return_value=False), \
             patch('fcntl.flock'):
            hook_module.cmd_activate(new_session, "myproject")

        state = self._read_state(hook_module)
        assert any(
            info.get("session_id") == new_session
            for info in state["slots"].values()
        )

    # T-019: all 4 slots genuinely occupied → error with slot list
    def test_t019_all_slots_occupied_exits_with_error(self, hook_module, tmp_ipc_dir, capsys):
        self._write_config(hook_module)
        # Fill all 4 slots with ACTIVE sessions (IPC + meta, daemon alive)
        slots = {}
        for i in range(1, 5):
            sid = f"active-{i}"
            write_session_ipc(tmp_ipc_dir, sid, meta=True)
            slots[str(i)] = make_slot(sid)

        self._write_state(hook_module, make_state(slots=slots, daemon_pid=12345))

        with patch.object(hook_module, 'is_daemon_alive', return_value=True), \
             patch('fcntl.flock'), \
             pytest.raises(SystemExit):
            hook_module.cmd_activate("brand-new-sess", "newproject")

        out = capsys.readouterr().out
        assert "occupied" in out.lower() or "slots" in out.lower()
