"""
Group 8: Pure formatting functions — no mocks needed.
Tests: T-054 to T-059
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
import bridge


# T-054
def test_escape_html_escapes_special_chars():
    assert bridge.escape_html("<b>&foo</b>") == "&lt;b&gt;&amp;foo&lt;/b&gt;"


# T-054 extended
def test_escape_html_escapes_lt_gt_amp():
    result = bridge.escape_html("a < b > c & d")
    assert "&lt;" in result
    assert "&gt;" in result
    assert "&amp;" in result
    assert "<" not in result.replace("&lt;", "").replace("&gt;", "")


# T-055
def test_format_permission_message_includes_slot_tool_description():
    event = {
        "tool_name": "Bash",
        "description": "Run git status",
    }
    msg = bridge.format_permission_message(event, slot="1")
    assert "Bash" in msg
    assert "Run git status" in msg
    assert "Permission" in msg


# T-056
def test_format_stop_message_truncates_at_600_chars():
    long_msg = "x" * 700
    event = {"last_message": long_msg}
    result = bridge.format_stop_message(event, slot="1")
    # Should truncate to 600 and add "..."
    assert "..." in result
    # The raw chars beyond 600 should not appear as-is
    assert len(result) < 750  # sanity check that it didn't balloon


def test_format_stop_message_short_message_not_truncated():
    event = {"last_message": "Done!"}
    result = bridge.format_stop_message(event, slot="1")
    assert "Done!" in result


# T-057
def test_format_notification_message_uses_correct_emoji_per_type():
    event_permission = {
        "notification_type": "permission_prompt",
        "message": "Permission needed",
        "title": "Claude",
    }
    msg = bridge.format_notification_message(event_permission, slot="1")
    assert "🔔" in msg

    event_idle = {
        "notification_type": "idle_prompt",
        "message": "Idle",
        "title": "Claude",
    }
    msg = bridge.format_notification_message(event_idle, slot="1")
    assert "💤" in msg

    event_unknown = {
        "notification_type": "unknown_type",
        "message": "Something",
        "title": "Claude",
    }
    msg = bridge.format_notification_message(event_unknown, slot="1")
    assert "📢" in msg


# T-058: _format_tool_description truncates Bash command at 300 chars
def test_format_tool_description_bash_truncates_at_300():
    import hook
    long_cmd = "x" * 500
    result = hook._format_tool_description("Bash", {"command": long_cmd})
    assert len(result) < 400  # Command itself is trimmed to 300
    assert "Bash" in result


# T-059: _format_tool_description for unknown tool shows 2 key-values
def test_format_tool_description_unknown_tool_shows_two_key_values():
    import hook
    tool_input = {
        "key1": "value1",
        "key2": "value2",
        "key3": "value3",  # should be ignored
    }
    result = hook._format_tool_description("UnknownTool", tool_input)
    assert "UnknownTool" in result
    assert "key1" in result
    assert "key2" in result
    assert "key3" not in result
