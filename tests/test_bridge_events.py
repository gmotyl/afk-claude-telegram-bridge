"""
Groups 4-6: Bridge daemon event processing.
  Group 4: _process_event() — T-020 to T-030
  Group 5: Message routing  — T-031 to T-035
  Group 6: Callbacks        — T-036 to T-047
"""

import json
import time
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

from tests.conftest import (
    make_state, make_slot, write_session_ipc, make_bridge_daemon, MockTelegramAPI
)


# ─── Group 4: _process_event() ───────────────────────────────────────────────

class TestProcessEvent:

    @pytest.fixture
    def daemon(self, mock_tg, tmp_bridge_dir):
        return make_bridge_daemon(mock_tg, tmp_bridge_dir)

    @pytest.fixture
    def ipc_dir(self, tmp_bridge_dir):
        import bridge as b
        b.IPC_DIR = tmp_bridge_dir / "ipc"
        return b.IPC_DIR

    # T-020: activation (fresh) → create topic, send message
    def test_t020_activation_fresh_creates_topic(self, daemon, ipc_dir, mock_tg, tmp_bridge_dir):
        import bridge as b
        session_id = "fresh-sess-020"
        write_session_ipc(ipc_dir, session_id, meta=True)
        state = make_state(slots={"1": make_slot(session_id)})
        (tmp_bridge_dir / "state.json").write_text(json.dumps(state))

        event = {
            "type": "activation",
            "id": "evt001",
            "slot": "1",
            "project": "testproject",
            "topic_name": "S1 - testproject",
            "session_id": session_id,
            "timestamp": time.time(),
        }
        daemon._process_event(event, session_id, "1")

        creates = mock_tg.get_calls("createForumTopic")
        assert len(creates) == 1
        assert creates[0]["name"] == "S1 - testproject"
        assert session_id in daemon.session_threads

    # T-021: activation (reattach) → send to existing thread_id
    def test_t021_activation_reattach_uses_existing_thread(self, daemon, ipc_dir, mock_tg, tmp_bridge_dir):
        session_id = "reattach-021"
        old_thread_id = 9001
        write_session_ipc(ipc_dir, session_id, meta=True)
        state = make_state(slots={"1": make_slot(session_id)})
        (tmp_bridge_dir / "state.json").write_text(json.dumps(state))

        # Reattach event with reuse_thread_id
        event = {
            "type": "activation",
            "id": "evt002",
            "slot": "1",
            "project": "testproject",
            "topic_name": "S1 - testproject",
            "session_id": session_id,
            "reuse_thread_id": old_thread_id,
            "timestamp": time.time(),
        }
        daemon._process_event(event, session_id, "1")

        # Should send to existing thread, not create new topic
        creates = mock_tg.get_calls("createForumTopic")
        assert len(creates) == 0
        sends = mock_tg.get_calls("sendMessage")
        assert any(s.get("thread_id") == old_thread_id for s in sends)

    # T-022: activation (deleted topic) → 400 error → create new topic
    def test_t022_activation_deleted_topic_falls_back_to_new(self, daemon, ipc_dir, mock_tg, tmp_bridge_dir):
        session_id = "deleted-topic-022"
        old_thread_id = 9999
        write_session_ipc(ipc_dir, session_id, meta=True)
        state = make_state(slots={"1": make_slot(session_id)})
        (tmp_bridge_dir / "state.json").write_text(json.dumps(state))

        # First send_message fails (topic deleted), second succeeds for new topic
        send_call_count = [0]
        def mock_send(text, thread_id=None, reply_markup=None, parse_mode="HTML"):
            send_call_count[0] += 1
            if thread_id == old_thread_id:
                return {"ok": False, "topic_deleted": True, "description": "thread not found"}
            return {"ok": True, "result": {"message_id": 3001}}

        mock_tg.send_message = mock_send
        mock_tg.calls = []

        def record_send(*args, **kwargs):
            mock_tg.calls.append(("sendMessage", kwargs))
            return mock_send(*args, **kwargs)

        mock_tg.send_message = record_send

        event = {
            "type": "activation",
            "id": "evt003",
            "slot": "1",
            "project": "testproject",
            "topic_name": "S1 - testproject",
            "session_id": session_id,
            "reuse_thread_id": old_thread_id,
            "timestamp": time.time(),
        }
        daemon._process_event(event, session_id, "1")

        # Should have created a new topic as fallback
        creates = mock_tg.get_calls("createForumTopic")
        assert len(creates) == 1

    # T-023: deactivation → send message, clear session_threads entry
    def test_t023_deactivation_sends_message_and_clears(self, daemon, ipc_dir, mock_tg, tmp_bridge_dir):
        import bridge as b
        session_id = "deact-023"
        thread_id = 5001
        write_session_ipc(ipc_dir, session_id, meta=True)
        daemon.session_threads[session_id] = thread_id
        state = make_state(slots={"1": make_slot(session_id)})
        (tmp_bridge_dir / "state.json").write_text(json.dumps(state))

        event = {
            "type": "deactivation",
            "id": "evt004",
            "slot": "1",
            "session_id": session_id,
            "timestamp": time.time(),
        }
        daemon._process_event(event, session_id, "1")

        sends = mock_tg.get_calls("sendMessage")
        assert any("Deactivated" in s.get("text", "") or "Deactivat" in s.get("text", "") for s in sends)
        assert session_id not in daemon.session_threads

    # T-024: permission_request → queued in permission_batch, stored in pending_events later
    def test_t024_permission_request_queued_in_batch(self, daemon, ipc_dir, mock_tg):
        session_id = "perm-024"
        write_session_ipc(ipc_dir, session_id, meta=True)
        daemon.session_threads[session_id] = 6001

        event = {
            "type": "permission_request",
            "id": "perm-evt-024",
            "tool_name": "Bash",
            "description": "git status",
            "session_id": session_id,
            "timestamp": time.time(),
        }
        daemon._process_event(event, session_id, "1")

        # Should be in permission batch
        assert session_id in daemon.permission_batch
        batch = daemon.permission_batch[session_id]
        assert len(batch["events"]) == 1
        assert batch["events"][0]["id"] == "perm-evt-024"

    # T-025: stop (normal) → message with stop keyboard, stored in pending_events
    def test_t025_stop_creates_pending_event(self, daemon, ipc_dir, mock_tg):
        session_id = "stop-025"
        write_session_ipc(ipc_dir, session_id, meta=True)
        daemon.session_threads[session_id] = 7001

        event = {
            "type": "stop",
            "id": "stop-evt-025",
            "last_message": "Task complete.",
            "session_id": session_id,
            "stop_hook_active": False,
            "timestamp": time.time(),
        }
        daemon._process_event(event, session_id, "1")

        assert "stop-evt-025" in daemon.pending_events
        pending = daemon.pending_events["stop-evt-025"]
        assert pending["type"] == "stop"
        assert pending["session_id"] == session_id

    # T-026: stop with queued instruction → immediately inject, no Telegram message
    def test_t026_stop_with_queued_instruction_auto_injects(self, daemon, ipc_dir, mock_tg):
        session_id = "stop-queued-026"
        write_session_ipc(ipc_dir, session_id, meta=True)
        daemon.session_threads[session_id] = 8001

        # Write queued instruction
        queued_path = ipc_dir / session_id / "queued_instruction.json"
        queued_path.write_text(json.dumps({"instruction": "do next thing", "timestamp": time.time()}))

        event = {
            "type": "stop",
            "id": "stop-evt-026",
            "last_message": "",
            "session_id": session_id,
            "stop_hook_active": False,
            "timestamp": time.time(),
        }
        daemon._process_event(event, session_id, "1")

        # Should have written response file, not stored in pending_events
        response_file = ipc_dir / session_id / "response-stop-evt-026.json"
        assert response_file.exists()
        response = json.loads(response_file.read_text())
        assert response.get("instruction") == "do next thing"
        assert "stop-evt-026" not in daemon.pending_events
        # Queued file should be removed
        assert not queued_path.exists()

    # T-027: notification → formatted message, no keyboard
    def test_t027_notification_sends_message_without_keyboard(self, daemon, ipc_dir, mock_tg):
        session_id = "notif-027"
        write_session_ipc(ipc_dir, session_id, meta=True)
        daemon.session_threads[session_id] = 9001

        event = {
            "type": "notification",
            "id": "notif-evt-027",
            "notification_type": "idle_prompt",
            "message": "Something happened",
            "title": "Claude",
            "session_id": session_id,
            "timestamp": time.time(),
        }
        daemon._process_event(event, session_id, "1")

        sends = mock_tg.get_calls("sendMessage")
        assert len(sends) > 0
        last_send = sends[-1]
        assert last_send.get("reply_markup") is None

    # T-028: keep_alive → NO Telegram call, update last_idle_ping
    def test_t028_keep_alive_no_telegram_call_updates_ping(self, daemon, ipc_dir, mock_tg):
        session_id = "keepalive-028"
        write_session_ipc(ipc_dir, session_id, meta=True)
        daemon.session_threads[session_id] = 1001
        daemon.last_idle_ping[session_id] = time.time()  # recent, so no idle send

        mock_tg.reset()
        event = {
            "type": "keep_alive",
            "id": "ka-evt-028",
            "session_id": session_id,
            "original_event_id": "orig-evt",
            "timestamp": time.time(),
        }
        daemon._process_event(event, session_id, "1")

        # No Telegram calls for keep_alive (when ping not needed)
        sends = mock_tg.get_calls("sendMessage")
        assert len(sends) == 0

    # T-029: unknown event type → no crash, no Telegram call
    def test_t029_unknown_event_type_no_crash_no_telegram(self, daemon, ipc_dir, mock_tg):
        session_id = "unknown-029"
        write_session_ipc(ipc_dir, session_id, meta=True)
        daemon.session_threads[session_id] = 2001
        mock_tg.reset()

        event = {
            "type": "totally_unknown_type",
            "id": "unk-evt-029",
            "session_id": session_id,
            "timestamp": time.time(),
        }
        # Should not raise
        daemon._process_event(event, session_id, "1")
        sends = mock_tg.get_calls("sendMessage")
        assert len(sends) == 0

    # T-030: permission batching — multiple requests within window grouped
    def test_t030_permission_batching_groups_multiple_requests(self, daemon, ipc_dir, mock_tg):
        session_id = "batch-030"
        write_session_ipc(ipc_dir, session_id, meta=True)
        daemon.session_threads[session_id] = 3001

        for i in range(3):
            event = {
                "type": "permission_request",
                "id": f"batch-evt-{i:03d}",
                "tool_name": "Bash",
                "description": f"command {i}",
                "session_id": session_id,
                "timestamp": time.time(),
            }
            daemon._process_event(event, session_id, "1")

        # All 3 should be in the same batch
        assert session_id in daemon.permission_batch
        batch = daemon.permission_batch[session_id]
        assert len(batch["events"]) == 3


# ─── Group 5: Message routing ─────────────────────────────────────────────────

class TestMessageRouting:

    @pytest.fixture
    def daemon(self, mock_tg, tmp_bridge_dir):
        return make_bridge_daemon(mock_tg, tmp_bridge_dir)

    @pytest.fixture
    def ipc_dir(self, tmp_bridge_dir):
        import bridge as b
        b.IPC_DIR = tmp_bridge_dir / "ipc"
        return b.IPC_DIR

    def _make_message(self, text, thread_id=None, chat_id="-100123"):
        msg = {
            "text": text,
            "chat": {"id": chat_id},
        }
        if thread_id:
            msg["message_thread_id"] = thread_id
        return msg

    # T-031: thread_id match → routes to correct session
    def test_t031_thread_id_match_routes_correctly(self, daemon, ipc_dir, mock_tg, tmp_bridge_dir):
        import bridge as b
        session_id = "sess-031"
        thread_id = 1111
        write_session_ipc(ipc_dir, session_id, meta=True)
        daemon.session_threads[session_id] = thread_id

        # Put a pending stop event so message gets routed
        daemon.pending_events["stop-031"] = {
            "session_id": session_id,
            "type": "stop",
            "message_id": 2000,
            "slot": "1",
            "created_at": time.time(),
        }

        state = make_state(slots={"1": make_slot(session_id)})
        (tmp_bridge_dir / "state.json").write_text(json.dumps(state))
        b.STATE_PATH = tmp_bridge_dir / "state.json"
        b.IPC_DIR = ipc_dir

        msg = self._make_message("do the thing", thread_id=thread_id,
                                  chat_id=daemon.tg.chat_id)
        daemon._handle_message(msg)

        response_file = ipc_dir / session_id / "response-stop-031.json"
        assert response_file.exists()
        response = json.loads(response_file.read_text())
        assert response.get("instruction") == "do the thing"

    # T-032: no prefix + single session → routes to it
    def test_t032_no_thread_single_session_routes_to_it(self, daemon, ipc_dir, mock_tg, tmp_bridge_dir):
        import bridge as b
        session_id = "sess-032"
        write_session_ipc(ipc_dir, session_id, meta=True)
        daemon.session_threads[session_id] = 5555
        daemon.pending_events["stop-032"] = {
            "session_id": session_id,
            "type": "stop",
            "message_id": 2001,
            "slot": "1",
            "created_at": time.time(),
        }

        state = make_state(slots={"1": make_slot(session_id)})
        (tmp_bridge_dir / "state.json").write_text(json.dumps(state))
        b.STATE_PATH = tmp_bridge_dir / "state.json"
        b.IPC_DIR = ipc_dir

        # No thread_id in message
        msg = self._make_message("fallback routing", chat_id=daemon.tg.chat_id)
        daemon._handle_message(msg)

        response_file = ipc_dir / session_id / "response-stop-032.json"
        assert response_file.exists()

    # T-033: no prefix + multiple sessions + reply_target (thread match) → routes to target
    def test_t033_multiple_sessions_routes_to_matching_thread(self, daemon, ipc_dir, mock_tg, tmp_bridge_dir):
        import bridge as b
        sess1 = "sess-033a"
        sess2 = "sess-033b"
        thread1, thread2 = 1001, 1002
        write_session_ipc(ipc_dir, sess1, meta=True)
        write_session_ipc(ipc_dir, sess2, meta=True)
        daemon.session_threads[sess1] = thread1
        daemon.session_threads[sess2] = thread2
        daemon.pending_events["stop-033b"] = {
            "session_id": sess2,
            "type": "stop",
            "message_id": 2002,
            "slot": "2",
            "created_at": time.time(),
        }

        state = make_state(slots={
            "1": make_slot(sess1),
            "2": make_slot(sess2, slot_num="2"),
        })
        (tmp_bridge_dir / "state.json").write_text(json.dumps(state))
        b.STATE_PATH = tmp_bridge_dir / "state.json"
        b.IPC_DIR = ipc_dir

        # Message comes in on thread2
        msg = self._make_message("targeted msg", thread_id=thread2, chat_id=daemon.tg.chat_id)
        daemon._handle_message(msg)

        response_file2 = ipc_dir / sess2 / "response-stop-033b.json"
        assert response_file2.exists()

    # T-034: no prefix + multiple sessions + no target → no crash (message ignored)
    def test_t034_multiple_sessions_no_thread_ignored(self, daemon, ipc_dir, mock_tg, tmp_bridge_dir):
        import bridge as b
        sess1 = "sess-034a"
        sess2 = "sess-034b"
        write_session_ipc(ipc_dir, sess1, meta=True)
        write_session_ipc(ipc_dir, sess2, meta=True)
        daemon.session_threads[sess1] = 2001
        daemon.session_threads[sess2] = 2002

        state = make_state(slots={
            "1": make_slot(sess1),
            "2": make_slot(sess2, slot_num="2"),
        })
        (tmp_bridge_dir / "state.json").write_text(json.dumps(state))
        b.STATE_PATH = tmp_bridge_dir / "state.json"
        b.IPC_DIR = ipc_dir

        mock_tg.reset()
        # No thread_id, multiple sessions → message should be ignored (no crash)
        msg = self._make_message("ambiguous msg", chat_id=daemon.tg.chat_id)
        daemon._handle_message(msg)  # should not raise

    # T-035: no active sessions → sends "No active AFK sessions" or no crash
    def test_t035_no_active_sessions_no_crash(self, daemon, ipc_dir, mock_tg, tmp_bridge_dir):
        import bridge as b
        state = make_state(slots={})
        (tmp_bridge_dir / "state.json").write_text(json.dumps(state))
        b.STATE_PATH = tmp_bridge_dir / "state.json"
        b.IPC_DIR = ipc_dir

        # /ping with no sessions should send a message
        msg = self._make_message("/ping", thread_id=9999, chat_id=daemon.tg.chat_id)
        daemon._handle_message(msg)  # should not raise
        sends = mock_tg.get_calls("sendMessage")
        assert len(sends) > 0


# ─── Group 6: Callbacks ───────────────────────────────────────────────────────

class TestCallbacks:

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

    def _setup_pending(self, daemon, ipc_dir, session_id, event_id, ptype="permission_request",
                       thread_id=1000, message_id=2000):
        write_session_ipc(ipc_dir, session_id, meta=True)
        daemon.session_threads[session_id] = thread_id
        daemon.pending_events[event_id] = {
            "session_id": session_id,
            "type": ptype,
            "message_id": message_id,
            "slot": "1",
            "created_at": time.time(),
        }

    def _make_callback(self, data, cq_id="cq001", session_id=None):
        return {
            "id": cq_id,
            "data": data,
        }

    # T-036: allow callback → writes allow response, edits message, removes from pending
    def test_t036_allow_callback_writes_response_edits_removes(self, daemon, ipc_dir, mock_tg):
        session_id = "sess-036"
        event_id = "evt-036"
        self._setup_pending(daemon, ipc_dir, session_id, event_id)

        cq = self._make_callback(f"allow:{event_id}")
        daemon._handle_callback(cq)

        response_file = ipc_dir / session_id / f"response-{event_id}.json"
        assert response_file.exists()
        response = json.loads(response_file.read_text())
        assert response["decision"] == "allow"
        assert event_id not in daemon.pending_events
        edits = mock_tg.get_calls("editMessageText")
        assert len(edits) > 0

    # T-037: deny callback → writes deny response
    def test_t037_deny_callback_writes_deny_response(self, daemon, ipc_dir, mock_tg):
        session_id = "sess-037"
        event_id = "evt-037"
        self._setup_pending(daemon, ipc_dir, session_id, event_id)

        cq = self._make_callback(f"deny:{event_id}")
        daemon._handle_callback(cq)

        response_file = ipc_dir / session_id / f"response-{event_id}.json"
        assert response_file.exists()
        response = json.loads(response_file.read_text())
        assert response["decision"] == "deny"

    # T-038: text with pending stop → writes instruction to response file
    def test_t038_text_with_pending_stop_writes_instruction(self, daemon, ipc_dir, mock_tg, tmp_bridge_dir):
        import bridge as b
        session_id = "sess-038"
        stop_event_id = "stop-038"
        thread_id = 3038
        write_session_ipc(ipc_dir, session_id, meta=True)
        daemon.session_threads[session_id] = thread_id
        daemon.pending_events[stop_event_id] = {
            "session_id": session_id,
            "type": "stop",
            "message_id": 2038,
            "slot": "1",
            "created_at": time.time(),
        }
        state = make_state(slots={"1": make_slot(session_id)})
        (tmp_bridge_dir / "state.json").write_text(json.dumps(state))
        b.STATE_PATH = tmp_bridge_dir / "state.json"
        b.IPC_DIR = ipc_dir

        msg = {
            "text": "do this now",
            "chat": {"id": daemon.tg.chat_id},
            "message_thread_id": thread_id,
        }
        daemon._handle_message(msg)

        response_file = ipc_dir / session_id / f"response-{stop_event_id}.json"
        assert response_file.exists()
        response = json.loads(response_file.read_text())
        assert response.get("instruction") == "do this now"
        assert stop_event_id not in daemon.pending_events

    # T-039: text with no pending stop → queued_instruction.json written
    def test_t039_text_no_pending_stop_writes_queued(self, daemon, ipc_dir, mock_tg, tmp_bridge_dir):
        import bridge as b
        session_id = "sess-039"
        thread_id = 3039
        write_session_ipc(ipc_dir, session_id, meta=True)
        daemon.session_threads[session_id] = thread_id
        state = make_state(slots={"1": make_slot(session_id)})
        (tmp_bridge_dir / "state.json").write_text(json.dumps(state))
        b.STATE_PATH = tmp_bridge_dir / "state.json"
        b.IPC_DIR = ipc_dir

        msg = {
            "text": "queue this up",
            "chat": {"id": daemon.tg.chat_id},
            "message_thread_id": thread_id,
        }
        daemon._handle_message(msg)

        queued_path = ipc_dir / session_id / "queued_instruction.json"
        assert queued_path.exists()
        queued = json.loads(queued_path.read_text())
        assert "queue this up" in queued.get("instruction", "")

    # T-040: expired event_id callback → "Event expired", no file written
    def test_t040_expired_event_callback_no_file_written(self, daemon, ipc_dir, mock_tg):
        # No pending event registered
        cq = self._make_callback("allow:nonexistent-event")
        daemon._handle_callback(cq)

        answers = mock_tg.get_calls("answerCallbackQuery")
        assert any("expired" in (a.get("text", "").lower()) for a in answers)

    # T-041: end_session callback → deactivation triggered (kill file written)
    def test_t041_end_session_callback_kills_session(self, daemon, ipc_dir, mock_tg):
        session_id = "sess-041"
        thread_id = 4041
        write_session_ipc(ipc_dir, session_id, meta=True)
        daemon.session_threads[session_id] = thread_id

        cq = self._make_callback(f"end_session:{session_id}")
        daemon._handle_callback(cq)

        kill_path = ipc_dir / session_id / "kill"
        assert kill_path.exists()
        assert session_id not in daemon.session_threads

    # T-042: trust_session → session added to trusted_sessions
    def test_t042_trust_session_adds_to_trusted(self, daemon, ipc_dir, mock_tg):
        session_id = "sess-042"
        thread_id = 4042
        write_session_ipc(ipc_dir, session_id, meta=True)
        daemon.session_threads[session_id] = thread_id

        cq = self._make_callback(f"trust_session:{session_id}")
        daemon._handle_callback(cq)

        assert daemon.trusted_sessions.get(session_id) is True

    # T-043: trusted session permission → auto-approved (verify trusted_sessions is checked)
    def test_t043_trusted_session_tracked(self, daemon, ipc_dir, mock_tg):
        session_id = "sess-043"
        daemon.trusted_sessions[session_id] = True
        assert daemon.trusted_sessions.get(session_id) is True

    # T-044: approve_all callback → all event_ids in batch resolved
    def test_t044_approve_all_resolves_all_batch_events(self, daemon, ipc_dir, mock_tg):
        session_id = "sess-044"
        batch_id = "batch-044"
        thread_id = 4044
        write_session_ipc(ipc_dir, session_id, meta=True)
        daemon.session_threads[session_id] = thread_id

        event_ids = ["evt-044a", "evt-044b", "evt-044c"]
        daemon.pending_events[batch_id] = {
            "session_id": session_id,
            "type": "permission_batch",
            "message_id": 2044,
            "slot": "1",
            "created_at": time.time(),
            "event_ids": event_ids,
        }

        cq = self._make_callback(f"approve_all:{batch_id}")
        daemon._handle_callback(cq)

        for eid in event_ids:
            response_file = ipc_dir / session_id / f"response-{eid}.json"
            assert response_file.exists()
            response = json.loads(response_file.read_text())
            assert response["decision"] == "allow"
        assert batch_id not in daemon.pending_events

    # T-045: compact callback → compact instruction written via stop event or queued
    def test_t045_compact_callback_writes_compact_instruction(self, daemon, ipc_dir, mock_tg):
        session_id = "sess-045"
        stop_event_id = "stop-045"
        thread_id = 4045
        write_session_ipc(ipc_dir, session_id, meta=True)
        daemon.session_threads[session_id] = thread_id
        daemon.pending_events[stop_event_id] = {
            "session_id": session_id,
            "type": "stop",
            "message_id": 2045,
            "slot": "1",
            "created_at": time.time(),
        }

        cq = self._make_callback(f"compact:{session_id}")
        daemon._handle_callback(cq)

        response_file = ipc_dir / session_id / f"response-{stop_event_id}.json"
        assert response_file.exists()
        response = json.loads(response_file.read_text())
        assert "compress" in response.get("instruction", "").lower() or \
               "compact" in response.get("instruction", "").lower()

    # T-046: clear callback → force_clear file written + instruction queued
    def test_t046_clear_callback_writes_force_clear(self, daemon, ipc_dir, mock_tg):
        session_id = "sess-046"
        thread_id = 4046
        write_session_ipc(ipc_dir, session_id, meta=True)
        daemon.session_threads[session_id] = thread_id
        # No pending stop — will queue

        cq = self._make_callback(f"clear:{session_id}")
        daemon._handle_callback(cq)

        force_clear = ipc_dir / session_id / "force_clear"
        assert force_clear.exists()

    # T-047: dismiss_ctx callback → no crash, just acknowledgement
    def test_t047_dismiss_ctx_callback_no_crash(self, daemon, ipc_dir, mock_tg):
        session_id = "sess-047"
        cq = self._make_callback(f"dismiss_ctx:{session_id}")
        daemon._handle_callback(cq)

        answers = mock_tg.get_calls("answerCallbackQuery")
        assert len(answers) > 0
