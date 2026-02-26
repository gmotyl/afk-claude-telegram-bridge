"""
Shared test fixtures and mock infrastructure.

Three core mocks at system boundaries:
  MockTelegramAPI     — captures calls, returns configurable responses
  MockFilesystem      — in-memory dict keyed by path
  MockProcessManager  — set of alive PIDs
"""

import json
import os
import sys
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Add repo root to path so we can import hook and bridge
REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT))


# ─── MockTelegramAPI ─────────────────────────────────────────────────────────

class MockTelegramAPI:
    """Captures all Telegram API calls and returns configurable responses."""

    def __init__(self, chat_id="-100123"):
        self.calls = []           # list of (method, kwargs)
        self.responses = {}       # method -> response to return
        self._default_ok = {"ok": True, "result": {}}
        self.chat_id = str(chat_id)

        # Default responses
        self.set_response("createForumTopic", {
            "ok": True,
            "result": {"message_thread_id": 1001}
        })
        self.set_response("sendMessage", {
            "ok": True,
            "result": {"message_id": 2001}
        })
        self.set_response("editMessageText", {"ok": True, "result": {}})
        self.set_response("deleteForumTopic", {"ok": True, "result": True})
        self.set_response("answerCallbackQuery", {"ok": True, "result": True})
        self.set_response("getUpdates", {"ok": True, "result": []})
        self.set_response("setMyCommands", {"ok": True, "result": True})

    def set_response(self, method, response):
        self.responses[method] = response

    def _record(self, method, **kwargs):
        self.calls.append((method, kwargs))
        return self.responses.get(method, self._default_ok)

    def get_calls(self, method):
        return [kw for m, kw in self.calls if m == method]

    def reset(self):
        self.calls.clear()

    # Mirror TelegramAPI interface
    def create_forum_topic(self, name):
        return self._record("createForumTopic", name=name)

    def delete_forum_topic(self, thread_id):
        return self._record("deleteForumTopic", thread_id=thread_id)

    def send_message(self, text, thread_id=None, reply_markup=None, parse_mode="HTML"):
        return self._record("sendMessage", text=text, thread_id=thread_id,
                            reply_markup=reply_markup, parse_mode=parse_mode)

    def edit_message(self, message_id, text, reply_markup=None, parse_mode="HTML"):
        return self._record("editMessageText", message_id=message_id, text=text,
                            reply_markup=reply_markup, parse_mode=parse_mode)

    def answer_callback(self, callback_query_id, text=""):
        return self._record("answerCallbackQuery", callback_query_id=callback_query_id, text=text)

    def send_chat_action(self, action="typing", thread_id=None):
        return self._record("sendChatAction", action=action, thread_id=thread_id)

    def get_updates(self, timeout=30):
        result = self._record("getUpdates", timeout=timeout)
        if result and result.get("ok"):
            return result.get("result", [])
        return []

    def set_my_commands(self):
        return self._record("setMyCommands")

    def _request(self, method, data=None):
        return self._record(method, data=data)


# ─── Fixtures ─────────────────────────────────────────────────────────────────

@pytest.fixture
def mock_tg():
    return MockTelegramAPI()


@pytest.fixture
def tmp_bridge_dir(tmp_path):
    """Create a temporary bridge directory structure."""
    bridge_dir = tmp_path / ".claude" / "hooks" / "telegram-bridge"
    bridge_dir.mkdir(parents=True)
    ipc_dir = bridge_dir / "ipc"
    ipc_dir.mkdir()
    return bridge_dir


@pytest.fixture
def tmp_ipc_dir(tmp_bridge_dir):
    return tmp_bridge_dir / "ipc"


@pytest.fixture
def alive_pids():
    """Set of PIDs considered 'alive' in tests."""
    return set()


@pytest.fixture
def hook_module(tmp_bridge_dir, alive_pids):
    """
    Import hook.py with patched filesystem paths pointing to tmp_bridge_dir.
    Returns the module with patched constants.
    """
    import importlib
    import hook as h

    original_bridge_dir = h.BRIDGE_DIR
    original_config = h.CONFIG_PATH
    original_state = h.STATE_PATH
    original_ipc = h.IPC_DIR
    original_lock = h.LOCK_PATH

    h.BRIDGE_DIR = str(tmp_bridge_dir)
    h.CONFIG_PATH = str(tmp_bridge_dir / "config.json")
    h.STATE_PATH = str(tmp_bridge_dir / "state.json")
    h.IPC_DIR = str(tmp_bridge_dir / "ipc")
    h.LOCK_PATH = str(tmp_bridge_dir / ".state.lock")

    yield h

    # Restore
    h.BRIDGE_DIR = original_bridge_dir
    h.CONFIG_PATH = original_config
    h.STATE_PATH = original_state
    h.IPC_DIR = original_ipc
    h.LOCK_PATH = original_lock


def make_state(slots=None, daemon_pid=None, daemon_heartbeat=None):
    """Helper to build a state dict."""
    return {
        "slots": slots or {},
        "daemon_pid": daemon_pid,
        "daemon_heartbeat": daemon_heartbeat or 0,
    }


def make_slot(session_id, project="test-project", slot_num="1",
              thread_id=None, topic_name=None):
    """Helper to build a slot info dict."""
    info = {
        "session_id": session_id,
        "project": project,
        "topic_name": topic_name or f"S{slot_num} - {project}",
        "started": "2026-02-26 10:00:00",
    }
    if thread_id:
        info["thread_id"] = thread_id
    return info


def write_session_ipc(ipc_dir, session_id, meta=True, kill=False, events=None):
    """Create IPC directory structure for a session."""
    session_dir = Path(ipc_dir) / session_id
    session_dir.mkdir(parents=True, exist_ok=True)

    if meta:
        meta_data = {
            "session_id": session_id,
            "slot": "1",
            "project": "test-project",
            "topic_name": "S1 - test-project",
            "started": "2026-02-26T10:00:00",
        }
        (session_dir / "meta.json").write_text(json.dumps(meta_data))

    if kill:
        (session_dir / "kill").write_text("test kill reason")

    if events:
        with open(session_dir / "events.jsonl", "a") as f:
            for event in events:
                f.write(json.dumps(event) + "\n")

    return session_dir


def make_bridge_daemon(mock_tg, tmp_bridge_dir, config=None):
    """
    Create a BridgeDaemon with mocked TelegramAPI and tmp filesystem.
    """
    import bridge as b

    # Write config
    cfg = config or {
        "bot_token": "test-token",
        "chat_id": "-1001234567890",
    }
    config_path = tmp_bridge_dir / "config.json"
    config_path.write_text(json.dumps(cfg))

    # Patch constants in bridge module
    b.CONFIG_PATH = tmp_bridge_dir / "config.json"
    b.STATE_PATH = tmp_bridge_dir / "state.json"
    b.IPC_DIR = tmp_bridge_dir / "ipc"

    daemon = b.BridgeDaemon.__new__(b.BridgeDaemon)
    daemon.config = cfg
    daemon.tg = mock_tg
    daemon.running = True
    daemon.event_positions = {}
    daemon.pending_events = {}
    daemon.session_threads = {}
    daemon.last_idle_ping = {}
    daemon.interaction_counts = {}
    daemon.context_warning_sent = {}
    daemon.typing_sessions = {}
    daemon.typing_last_sent = {}
    daemon.permission_batch = {}
    daemon.trusted_sessions = {}
    daemon.approval_counts = {}

    return daemon
