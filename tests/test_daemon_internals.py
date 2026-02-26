"""
Bridge daemon internal methods.

Scenarios:
  I-001: _flush_permission_batches — single event → sends normal permission message
  I-002: _flush_permission_batches — multiple events → sends batched "Approve All" message
  I-003: _flush_permission_batches — batch within window → not flushed yet
  I-004: _flush_permission_batches — trusted session, single → auto-approved
  I-005: _flush_permission_batches — trusted session, batch → all auto-approved
  I-006: _update_typing — sends typing action when session is typing
  I-007: _update_typing — skips if typed recently (<4.5s)
  I-008: _update_typing — skips if session not typing
  I-009: _check_stale_events — warns when pending event > stale_seconds
  I-010: _check_stale_events — no warning within threshold
  I-011: _increment_interaction — context warning at threshold
  I-012: _increment_interaction — second warning at 125% threshold
  I-013: _auto_approve_permission — writes allow, sends message, sets typing
  I-014: _track_approval — offers trust after threshold reached
  I-015: _send_to_session — kills session when topic deleted
"""

import json
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from tests.conftest import make_state, make_slot, write_session_ipc, make_bridge_daemon


class TestFlushPermissionBatches:

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

    def _make_batch(self, session_id, events, thread_id=1000, slot="1", age_seconds=3):
        return {
            "events": events,
            "timer_start": time.time() - age_seconds,
            "thread_id": thread_id,
            "slot": slot,
        }

    def _make_perm_event(self, event_id, tool="Bash", desc="git status"):
        return {"id": event_id, "type": "permission_request",
                "tool_name": tool, "description": desc, "session_id": "x"}

    # I-001: single event → sends normal permission message with Approve/Deny buttons
    def test_i001_single_event_sends_normal_message(self, daemon, ipc_dir, mock_tg, tmp_bridge_dir):
        session_id = "sess-i001"
        write_session_ipc(ipc_dir, session_id, meta=True)
        daemon.session_threads[session_id] = 1001
        state = make_state(slots={"1": make_slot(session_id)})
        (tmp_bridge_dir / "state.json").write_text(json.dumps(state))

        event = self._make_perm_event("evt-i001")
        event["session_id"] = session_id
        daemon.permission_batch[session_id] = self._make_batch(session_id, [event])

        daemon._flush_permission_batches()

        sends = mock_tg.get_calls("sendMessage")
        assert len(sends) > 0
        last = sends[-1]
        # Should have reply_markup with Allow/Deny buttons
        assert last.get("reply_markup") is not None
        kb = last["reply_markup"]["inline_keyboard"]
        flat = [btn for row in kb for btn in row]
        assert any("allow:evt-i001" in b.get("callback_data", "") for b in flat)
        assert "evt-i001" in daemon.pending_events

    # I-002: multiple events → sends batched message with "Approve All"
    def test_i002_multiple_events_sends_batch_message(self, daemon, ipc_dir, mock_tg, tmp_bridge_dir):
        session_id = "sess-i002"
        write_session_ipc(ipc_dir, session_id, meta=True)
        daemon.session_threads[session_id] = 1002
        state = make_state(slots={"1": make_slot(session_id)})
        (tmp_bridge_dir / "state.json").write_text(json.dumps(state))

        events = [self._make_perm_event(f"evt-i002-{i}") for i in range(3)]
        for e in events:
            e["session_id"] = session_id
        daemon.permission_batch[session_id] = self._make_batch(session_id, events)

        daemon._flush_permission_batches()

        sends = mock_tg.get_calls("sendMessage")
        assert len(sends) > 0
        last = sends[-1]
        assert last.get("reply_markup") is not None
        kb = last["reply_markup"]["inline_keyboard"]
        flat = [btn for row in kb for btn in row]
        assert any("approve_all:" in b.get("callback_data", "") for b in flat)
        # Batch id stored in pending_events
        batch_ids = [eid for eid, info in daemon.pending_events.items()
                     if info.get("type") == "permission_batch"]
        assert len(batch_ids) == 1

    # I-003: batch within window → not flushed yet
    def test_i003_batch_within_window_not_flushed(self, daemon, ipc_dir, mock_tg):
        session_id = "sess-i003"
        write_session_ipc(ipc_dir, session_id, meta=True)
        daemon.session_threads[session_id] = 1003

        event = self._make_perm_event("evt-i003")
        event["session_id"] = session_id
        # age_seconds=0 → within batch window
        daemon.permission_batch[session_id] = self._make_batch(session_id, [event], age_seconds=0)
        mock_tg.reset()

        daemon._flush_permission_batches()

        sends = mock_tg.get_calls("sendMessage")
        assert len(sends) == 0
        assert session_id in daemon.permission_batch  # Still waiting

    # I-004: trusted session, single event → auto-approved (no Telegram prompt)
    def test_i004_trusted_session_single_auto_approved(self, daemon, ipc_dir, mock_tg):
        session_id = "sess-i004"
        write_session_ipc(ipc_dir, session_id, meta=True)
        daemon.session_threads[session_id] = 1004
        daemon.trusted_sessions[session_id] = True

        event = self._make_perm_event("evt-i004")
        event["session_id"] = session_id
        daemon.permission_batch[session_id] = self._make_batch(session_id, [event])

        daemon._flush_permission_batches()

        response_file = ipc_dir / session_id / "response-evt-i004.json"
        assert response_file.exists()
        response = json.loads(response_file.read_text())
        assert response["decision"] == "allow"
        assert "evt-i004" not in daemon.pending_events

    # I-005: trusted session, batch → all auto-approved
    def test_i005_trusted_session_batch_all_auto_approved(self, daemon, ipc_dir, mock_tg):
        session_id = "sess-i005"
        write_session_ipc(ipc_dir, session_id, meta=True)
        daemon.session_threads[session_id] = 1005
        daemon.trusted_sessions[session_id] = True

        events = [self._make_perm_event(f"evt-i005-{i}") for i in range(3)]
        for e in events:
            e["session_id"] = session_id
        daemon.permission_batch[session_id] = self._make_batch(session_id, events)

        daemon._flush_permission_batches()

        for i in range(3):
            rf = ipc_dir / session_id / f"response-evt-i005-{i}.json"
            assert rf.exists()
            assert json.loads(rf.read_text())["decision"] == "allow"


class TestUpdateTyping:

    @pytest.fixture
    def daemon(self, mock_tg, tmp_bridge_dir):
        d = make_bridge_daemon(mock_tg, tmp_bridge_dir)
        import bridge as b
        b.IPC_DIR = tmp_bridge_dir / "ipc"
        return d

    # I-006: sends typing action when session is typing and enough time has passed
    def test_i006_sends_typing_when_active(self, daemon, mock_tg):
        session_id = "sess-i006"
        daemon.session_threads[session_id] = 6001
        daemon.typing_sessions[session_id] = True
        daemon.typing_last_sent[session_id] = time.time() - 10  # 10s ago

        mock_tg.reset()
        daemon._update_typing()

        actions = mock_tg.get_calls("sendChatAction")
        assert len(actions) > 0
        assert any(a.get("thread_id") == 6001 for a in actions)

    # I-007: skips if typed recently (<4.5s)
    def test_i007_skips_if_typed_recently(self, daemon, mock_tg):
        session_id = "sess-i007"
        daemon.session_threads[session_id] = 7001
        daemon.typing_sessions[session_id] = True
        daemon.typing_last_sent[session_id] = time.time() - 1  # 1s ago

        mock_tg.reset()
        daemon._update_typing()

        actions = mock_tg.get_calls("sendChatAction")
        assert len(actions) == 0

    # I-008: skips if session not typing
    def test_i008_skips_if_not_typing(self, daemon, mock_tg):
        session_id = "sess-i008"
        daemon.session_threads[session_id] = 8001
        daemon.typing_sessions[session_id] = False
        daemon.typing_last_sent[session_id] = time.time() - 10

        mock_tg.reset()
        daemon._update_typing()

        actions = mock_tg.get_calls("sendChatAction")
        assert len(actions) == 0


class TestCheckStaleEvents:

    @pytest.fixture
    def daemon(self, mock_tg, tmp_bridge_dir):
        d = make_bridge_daemon(mock_tg, tmp_bridge_dir)
        import bridge as b
        b.IPC_DIR = tmp_bridge_dir / "ipc"
        return d

    # I-009: warns when pending event older than stale_seconds
    def test_i009_warns_on_stale_event(self, daemon, mock_tg):
        session_id = "sess-i009"
        daemon.session_threads[session_id] = 9001
        daemon.pending_events["stale-evt"] = {
            "session_id": session_id,
            "type": "permission_request",
            "message_id": 1000,
            "slot": "1",
            "created_at": time.time() - 200,  # 200s ago (> default 90s)
        }
        daemon.config["stale_warning_seconds"] = 90

        mock_tg.reset()
        daemon._check_stale_events()

        sends = mock_tg.get_calls("sendMessage")
        assert len(sends) > 0
        assert any("pending" in s.get("text", "").lower() or
                   "unresponsive" in s.get("text", "").lower()
                   for s in sends)

    # I-010: no warning within threshold
    def test_i010_no_warning_within_threshold(self, daemon, mock_tg):
        session_id = "sess-i010"
        daemon.session_threads[session_id] = 10001
        daemon.pending_events["fresh-evt"] = {
            "session_id": session_id,
            "type": "permission_request",
            "message_id": 1001,
            "slot": "1",
            "created_at": time.time() - 30,  # 30s ago (< 90s threshold)
        }
        daemon.config["stale_warning_seconds"] = 90

        mock_tg.reset()
        daemon._check_stale_events()

        sends = mock_tg.get_calls("sendMessage")
        assert len(sends) == 0


class TestIncrementInteraction:

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

    # I-011: context warning at threshold
    def test_i011_context_warning_at_threshold(self, daemon, ipc_dir, mock_tg):
        session_id = "sess-i011"
        write_session_ipc(ipc_dir, session_id, meta=True)
        daemon.session_threads[session_id] = 11001
        daemon.config["context_warning_threshold"] = 5
        daemon.interaction_counts[session_id] = 4  # One below threshold

        mock_tg.reset()
        daemon._increment_interaction(session_id)  # Now at 5 (threshold)

        sends = mock_tg.get_calls("sendMessage")
        assert any("context" in s.get("text", "").lower() or
                   "warning" in s.get("text", "").lower()
                   for s in sends)

    # I-012: second warning at 125% threshold
    def test_i012_second_warning_at_125_percent(self, daemon, ipc_dir, mock_tg):
        session_id = "sess-i012"
        write_session_ipc(ipc_dir, session_id, meta=True)
        daemon.session_threads[session_id] = 12001
        daemon.config["context_warning_threshold"] = 4
        threshold_125 = int(4 * 1.25)  # = 5
        daemon.interaction_counts[session_id] = threshold_125 - 1
        daemon.context_warning_sent[session_id] = 4  # first warning already sent

        mock_tg.reset()
        daemon._increment_interaction(session_id)

        sends = mock_tg.get_calls("sendMessage")
        assert len(sends) > 0


class TestAutoApproveAndTrust:

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

    # I-013: _auto_approve_permission → writes allow, sends message, sets typing
    def test_i013_auto_approve_writes_allow_sets_typing(self, daemon, ipc_dir, mock_tg):
        session_id = "sess-i013"
        write_session_ipc(ipc_dir, session_id, meta=True)
        daemon.session_threads[session_id] = 13001

        event = {"id": "evt-i013", "type": "permission_request",
                 "tool_name": "Read", "session_id": session_id}
        mock_tg.reset()
        daemon._auto_approve_permission(event, session_id)

        response_file = ipc_dir / session_id / "response-evt-i013.json"
        assert response_file.exists()
        assert json.loads(response_file.read_text())["decision"] == "allow"
        assert daemon.typing_sessions.get(session_id) is True
        sends = mock_tg.get_calls("sendMessage")
        assert any("auto-approved" in s.get("text", "").lower() or
                   "Auto-approved" in s.get("text", "") for s in sends)

    # I-014: _track_approval → offers trust after threshold
    def test_i014_track_approval_offers_trust_after_threshold(self, daemon, mock_tg):
        session_id = "sess-i014"
        daemon.session_threads[session_id] = 14001
        daemon.config["session_trust_threshold"] = 3
        daemon.approval_counts[session_id] = 2  # One below threshold

        mock_tg.reset()
        daemon._track_approval(session_id)  # Now at 3 (threshold)

        sends = mock_tg.get_calls("sendMessage")
        assert len(sends) > 0
        assert any("trust" in s.get("text", "").lower() for s in sends)
        trust_kb = [s for s in sends if s.get("reply_markup")]
        assert len(trust_kb) > 0

    # I-015: _send_to_session → kills session when topic deleted
    def test_i015_send_to_session_kills_on_deleted_topic(self, daemon, ipc_dir, mock_tg, tmp_bridge_dir):
        import bridge as b
        session_id = "sess-i015"
        write_session_ipc(ipc_dir, session_id, meta=True)
        daemon.session_threads[session_id] = 15001
        state = make_state(slots={"1": make_slot(session_id)})
        (tmp_bridge_dir / "state.json").write_text(json.dumps(state))
        b.STATE_PATH = tmp_bridge_dir / "state.json"

        mock_tg.set_response("sendMessage", {
            "ok": False, "topic_deleted": True, "description": "thread not found"
        })

        result = daemon._send_to_session("test message", session_id)

        assert result is None
        kill_file = ipc_dir / session_id / "kill"
        assert kill_file.exists()
