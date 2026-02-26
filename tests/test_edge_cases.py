"""
Group 7: Real bug regression tests.
  T-048: ctrl+c → /afk reattach carries thread_id in activation event
  T-049: daemon state cleanup on reattach removes old session_threads, pending_events, typing
  T-050: deleted topic fallback (no #general)
  T-051: stale stop event from old session doesn't block new session routing
  T-052: IPC scan position tracking (no re-processing)
  T-053: heartbeat boundary (89s alive, 91s stale)
"""

import json
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from tests.conftest import (
    make_state, make_slot, write_session_ipc, make_bridge_daemon, MockTelegramAPI
)


class TestRegressions:

    @pytest.fixture
    def daemon(self, mock_tg, tmp_bridge_dir):
        d = make_bridge_daemon(mock_tg, tmp_bridge_dir)
        import bridge as b
        b.IPC_DIR = tmp_bridge_dir / "ipc"
        return d

    @pytest.fixture
    def ipc_dir(self, tmp_bridge_dir):
        import bridge as b
        return b.IPC_DIR

    # T-048: ctrl+c → /afk reattach carries thread_id in activation event
    def test_t048_reattach_activation_event_carries_thread_id(self, daemon, ipc_dir, mock_tg, tmp_bridge_dir):
        """
        Bug: After Ctrl+C, /afk was not passing reuse_thread_id to activation event,
        so daemon created a new topic instead of reattaching to the existing one.
        """
        import hook

        config_path = tmp_bridge_dir / "config.json"
        config_path.write_text(json.dumps({"bot_token": "tok", "chat_id": "-100123"}))
        state_path = tmp_bridge_dir / "state.json"

        old_session = "old-sess-t048"
        new_session = "new-sess-t048"
        thread_id = 8888
        project = "myproject"
        topic_name = f"S1 - {project}"

        # Simulate old session: no kill file (daemon still alive as separate process,
        # user Ctrl+C'd Claude Code but the bridge daemon keeps running).
        # The old slot looks "active" to cleanup_stale_slots, so it survives.
        # The reattach code then detects: same project+topic, different session_id → reattach.
        write_session_ipc(ipc_dir, old_session, meta=True, kill=False)
        old_state = make_state(
            slots={"1": {**make_slot(old_session, project=project, topic_name=topic_name),
                         "thread_id": thread_id}},
            daemon_pid=12345,
            daemon_heartbeat=time.time()
        )
        state_path.write_text(json.dumps(old_state))

        # Patch hook module paths
        original_bridge_dir = hook.BRIDGE_DIR
        original_ipc = hook.IPC_DIR
        original_state = hook.STATE_PATH
        original_config = hook.CONFIG_PATH
        original_lock = hook.LOCK_PATH
        hook.BRIDGE_DIR = str(tmp_bridge_dir)
        hook.IPC_DIR = str(ipc_dir)
        hook.STATE_PATH = str(state_path)
        hook.CONFIG_PATH = str(config_path)
        hook.LOCK_PATH = str(tmp_bridge_dir / ".state.lock")

        try:
            with patch.object(hook, 'start_daemon', return_value=1234), \
                 patch.object(hook, 'is_daemon_alive', return_value=True), \
                 patch('fcntl.flock'):
                hook.cmd_activate(new_session, project, topic_name)
        finally:
            hook.BRIDGE_DIR = original_bridge_dir
            hook.IPC_DIR = original_ipc
            hook.STATE_PATH = original_state
            hook.CONFIG_PATH = original_config
            hook.LOCK_PATH = original_lock

        # Verify activation event has reuse_thread_id
        events_file = ipc_dir / new_session / "events.jsonl"
        assert events_file.exists()
        events = [json.loads(l) for l in events_file.read_text().strip().split("\n") if l.strip()]
        activation = next(e for e in events if e["type"] == "activation")
        assert activation.get("reuse_thread_id") == thread_id, \
            f"Expected reuse_thread_id={thread_id}, got {activation.get('reuse_thread_id')}"

    # T-049: daemon state cleanup on reattach removes old session_threads, pending_events, typing
    def test_t049_reattach_cleans_daemon_state(self, daemon, ipc_dir, mock_tg, tmp_bridge_dir):
        """
        Bug: When reattaching, daemon was keeping stale state (session_threads, pending_events,
        typing_sessions) for old session_id, causing routing failures.
        """
        old_session = "old-sess-t049"
        new_session = "new-sess-t049"
        thread_id = 7777

        # Set up daemon state for old session
        daemon.session_threads[old_session] = thread_id
        daemon.pending_events["stale-evt"] = {
            "session_id": old_session,
            "type": "stop",
            "message_id": 1000,
            "slot": "1",
            "created_at": time.time(),
        }
        daemon.typing_sessions[old_session] = True
        daemon.last_idle_ping[old_session] = time.time()

        write_session_ipc(ipc_dir, new_session, meta=True)
        state = make_state(slots={"1": make_slot(new_session)})
        (tmp_bridge_dir / "state.json").write_text(json.dumps(state))

        # Activation event with reuse_thread_id → daemon should clean up old session
        event = {
            "type": "activation",
            "id": "evt-t049",
            "slot": "1",
            "project": "myproject",
            "topic_name": "S1 - myproject",
            "session_id": new_session,
            "reuse_thread_id": thread_id,
            "timestamp": time.time(),
        }
        daemon._process_event(event, new_session, "1")

        # Old session state should be cleaned up
        assert old_session not in daemon.session_threads
        assert old_session not in daemon.typing_sessions
        # Stale pending event for old session should be gone
        stale_events = [eid for eid, info in daemon.pending_events.items()
                        if info.get("session_id") == old_session]
        assert len(stale_events) == 0

    # T-050: deleted topic fallback → 400 error → create new topic, no #general fallback
    def test_t050_deleted_topic_creates_new_not_general(self, daemon, ipc_dir, mock_tg, tmp_bridge_dir):
        """
        Bug: When Telegram topic was deleted, bridge was trying to fall back to #general
        (thread_id=None) instead of creating a new topic.
        """
        session_id = "sess-t050"
        old_thread_id = 5555
        write_session_ipc(ipc_dir, session_id, meta=True)
        daemon.session_threads[session_id] = old_thread_id
        state = make_state(slots={"1": make_slot(session_id)})
        (tmp_bridge_dir / "state.json").write_text(json.dumps(state))

        send_calls = []
        def mock_send(text, thread_id=None, **kwargs):
            send_calls.append({"text": text, "thread_id": thread_id})
            if thread_id == old_thread_id:
                return {"ok": False, "topic_deleted": True, "description": "thread not found"}
            return {"ok": True, "result": {"message_id": 9001}}

        mock_tg.send_message = mock_send

        event = {
            "type": "activation",
            "id": "evt-t050",
            "slot": "1",
            "project": "myproject",
            "topic_name": "S1 - myproject",
            "session_id": session_id,
            "reuse_thread_id": old_thread_id,
            "timestamp": time.time(),
        }
        daemon._process_event(event, session_id, "1")

        # Should have created a new topic (not fallen back to general/None)
        creates = mock_tg.get_calls("createForumTopic")
        assert len(creates) == 1, "Should create new topic when old one is deleted"
        # The fallback message should NOT use thread_id=None (that would be #general)
        general_fallback_sends = [s for s in send_calls if s["thread_id"] is None and
                                  "Activated" in s.get("text", "")]
        assert len(general_fallback_sends) == 0, "Should not fall back to #general"

    # T-051: stale stop event from old session doesn't block new session routing
    def test_t051_stale_stop_event_doesnt_block_new_session(self, daemon, ipc_dir, mock_tg, tmp_bridge_dir):
        """
        Bug: Stale pending stop event from old Ctrl+C session was routing new messages
        to the wrong (dead) session instead of the new one.
        """
        import bridge as b
        old_session = "old-sess-t051"
        new_session = "new-sess-t051"
        thread_id = 6006

        # New session is active
        write_session_ipc(ipc_dir, new_session, meta=True)
        daemon.session_threads[new_session] = thread_id

        # But there's a stale pending stop from old session
        daemon.pending_events["stale-stop-t051"] = {
            "session_id": old_session,
            "type": "stop",
            "message_id": 5000,
            "slot": "1",
            "created_at": time.time() - 3600,  # 1 hour ago
        }
        # No IPC for old session (it's dead)

        state = make_state(slots={"1": make_slot(new_session)})
        (tmp_bridge_dir / "state.json").write_text(json.dumps(state))
        b.STATE_PATH = tmp_bridge_dir / "state.json"
        b.IPC_DIR = ipc_dir

        # New message arrives on new session's thread
        # Put a pending stop for the new session too
        daemon.pending_events["new-stop-t051"] = {
            "session_id": new_session,
            "type": "stop",
            "message_id": 5001,
            "slot": "1",
            "created_at": time.time(),
        }

        msg = {
            "text": "new instruction",
            "chat": {"id": daemon.tg.chat_id},
            "message_thread_id": thread_id,
        }
        daemon._handle_message(msg)

        # Instruction should be routed to new session
        response_file = ipc_dir / new_session / "response-new-stop-t051.json"
        assert response_file.exists(), "New session should receive the instruction"
        response = json.loads(response_file.read_text())
        assert response.get("instruction") == "new instruction"

    # T-052: IPC scan position tracking — events not re-processed on second scan
    def test_t052_event_position_tracking_no_reprocessing(self, daemon, ipc_dir, tmp_bridge_dir):
        """
        Bug: event_positions was not being updated after scanning, causing events to be
        re-processed on every scan cycle.
        """
        import bridge as b
        session_id = "sess-t052"
        write_session_ipc(ipc_dir, session_id, meta=True)
        daemon.session_threads[session_id] = 5052
        state = make_state(slots={"1": make_slot(session_id)})
        (tmp_bridge_dir / "state.json").write_text(json.dumps(state))
        b.STATE_PATH = tmp_bridge_dir / "state.json"
        b.IPC_DIR = ipc_dir

        # Write one event to events.jsonl
        event = {
            "type": "notification",
            "id": "notif-t052",
            "notification_type": "idle_prompt",
            "message": "test",
            "title": "Test",
            "session_id": session_id,
            "timestamp": time.time(),
        }
        events_file = ipc_dir / session_id / "events.jsonl"
        events_file.write_text(json.dumps(event) + "\n")

        # First scan
        daemon._scan_events()
        first_scan_sends = len(daemon.tg.calls)

        # Second scan — should not reprocess same event
        daemon._scan_events()
        second_scan_sends = len(daemon.tg.calls)

        assert second_scan_sends == first_scan_sends, \
            "Events should not be re-processed on second scan"

    # T-053: heartbeat boundary — 89s alive, 91s stale
    def test_t053_heartbeat_boundary_89s_alive_91s_stale(self, hook_module, tmp_ipc_dir):
        """
        The threshold for heartbeat staleness is 60s. Verify the exact boundary:
        - heartbeat 59s ago → alive
        - heartbeat 61s ago → stale (when daemon is dead)
        """
        session_id = "sess-t053"
        write_session_ipc(tmp_ipc_dir, session_id, meta=True)

        now = time.time()

        # 59s ago → alive (below 60s threshold)
        state_fresh = make_state(
            slots={"1": make_slot(session_id)},
            daemon_pid=99999,
            daemon_heartbeat=now - 59
        )
        with patch.object(hook_module, 'is_daemon_alive', return_value=False):
            active, reason = hook_module.is_slot_actually_active(state_fresh, "1", now)
        assert active is True, f"59s heartbeat should still be alive, got {reason}"

        # 61s ago → stale (above 60s threshold)
        write_session_ipc(tmp_ipc_dir, session_id, meta=True)  # recreate (previous test may have run cleanup)
        state_stale = make_state(
            slots={"1": make_slot(session_id)},
            daemon_pid=99999,
            daemon_heartbeat=now - 61
        )
        with patch.object(hook_module, 'is_daemon_alive', return_value=False):
            active, reason = hook_module.is_slot_actually_active(state_stale, "1", now)
        assert active is False, f"61s heartbeat should be stale, got active={active}"
        assert reason == "daemon_dead"
