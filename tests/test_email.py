"""What the log says when mail does not go out.

These tests exist because the failure they cover was silent in production:
the send raised, the sign-in request succeeded anyway, and nothing readable
was written down. Each one asserts on the log, not just on the exception.
"""

import logging
import smtplib

import pytest

from core.config import Settings
from core.email import AUTH_HINT, EmailSendError, send_email


def configure(monkeypatch, **overrides) -> Settings:
    """Point core.email at a settings object built for one test."""
    settings = Settings(environment="test", **overrides)
    monkeypatch.setattr("core.email.get_settings", lambda: settings)
    return settings


class FakeSMTP:
    """Stands in for smtplib.SMTP, recording the calls that matter."""

    instances: list["FakeSMTP"] = []

    def __init__(self, host, port, timeout=None, context=None):
        self.host, self.port, self.timeout = host, port, timeout
        self.started_tls = False
        self.login_args: tuple[str, str] | None = None
        self.sent: list[object] = []
        self.login_error: Exception | None = None
        self.send_error: Exception | None = None
        FakeSMTP.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def set_debuglevel(self, level):
        self.debuglevel = level

    def starttls(self, context=None):
        self.started_tls = True

    def login(self, username, password):
        if self.login_error:
            raise self.login_error
        self.login_args = (username, password)

    def send_message(self, msg):
        if self.send_error:
            raise self.send_error
        self.sent.append(msg)


@pytest.fixture
def smtp(monkeypatch):
    FakeSMTP.instances = []
    monkeypatch.setattr(smtplib, "SMTP", FakeSMTP)
    monkeypatch.setattr(smtplib, "SMTP_SSL", FakeSMTP)
    return FakeSMTP


def test_without_smtp_the_message_goes_to_the_log_and_does_not_raise(monkeypatch, caplog, capsys):
    configure(monkeypatch, smtp_host="", smtp_username="")
    with caplog.at_level(logging.INFO, logger="core.email"):
        send_email(to="lea@example.com", subject="Your Piggy sign-in code", body="123456")

    assert "no SMTP configured" in caplog.text
    # The reason is named, so the log says why rather than only what.
    assert "SMTP_HOST and SMTP_USERNAME empty" in caplog.text
    assert "123456" in capsys.readouterr().out


def test_an_empty_password_is_reported_as_missing_not_as_a_bad_password(monkeypatch, caplog, smtp):
    configure(monkeypatch, smtp_host="mail.infomaniak.com", smtp_username="piggy@example.com", smtp_password="")

    with caplog.at_level(logging.ERROR, logger="core.email"), pytest.raises(EmailSendError):
        send_email(to="lea@example.com", subject="hi", body="body")

    assert "SMTP_PASSWORD is empty" in caplog.text
    # Nothing was dialled: an empty password is a configuration fault, and
    # letting the relay answer it would disguise it as a rejected password.
    assert smtp.instances == []


def test_a_refused_login_names_the_connected_device_password(monkeypatch, caplog, smtp):
    configure(
        monkeypatch,
        smtp_host="mail.infomaniak.com",
        smtp_username="piggy@example.com",
        smtp_password="generated-by-terraform",
    )

    def fail(host, port, timeout=None, context=None):
        conn = FakeSMTP(host, port, timeout)
        conn.login_error = smtplib.SMTPAuthenticationError(535, b"5.7.8 Authentication failed")
        return conn

    monkeypatch.setattr(smtplib, "SMTP", fail)

    with caplog.at_level(logging.ERROR, logger="core.email"), pytest.raises(EmailSendError) as excinfo:
        send_email(to="lea@example.com", subject="hi", body="body")

    assert "SMTP login refused" in caplog.text
    assert "535" in caplog.text and "Authentication failed" in caplog.text
    # The whole point: the log tells you where to go, not just that it broke.
    assert "connected device" in caplog.text
    assert AUTH_HINT in str(excinfo.value)


def test_a_successful_send_is_recorded(monkeypatch, caplog, smtp):
    configure(
        monkeypatch,
        smtp_host="mail.infomaniak.com",
        smtp_username="piggy@example.com",
        smtp_password="app-password",
        email_sender="piggy@example.com",
    )

    with caplog.at_level(logging.INFO, logger="core.email"):
        send_email(to="lea@example.com", subject="Your Piggy sign-in code", body="123456")

    conn = smtp.instances[0]
    assert conn.started_tls
    assert conn.login_args == ("piggy@example.com", "app-password")
    assert len(conn.sent) == 1
    assert "sending" in caplog.text and "sent" in caplog.text
    # The credential itself never reaches the log.
    assert "app-password" not in caplog.text


def test_port_465_is_implicit_tls_and_is_never_upgraded(monkeypatch, smtp):
    configure(
        monkeypatch,
        smtp_host="mail.infomaniak.com",
        smtp_port=465,
        smtp_username="piggy@example.com",
        smtp_password="app-password",
    )

    send_email(to="lea@example.com", subject="hi", body="body")

    conn = smtp.instances[0]
    assert conn.port == 465
    # STARTTLS on an already-wrapped socket is a protocol error, not an upgrade.
    assert not conn.started_tls


def test_a_dead_relay_is_logged_with_the_route_it_failed_on(monkeypatch, caplog):
    configure(
        monkeypatch,
        smtp_host="mail.infomaniak.com",
        smtp_username="piggy@example.com",
        smtp_password="app-password",
    )

    def refuse(host, port, timeout=None, context=None):
        raise TimeoutError("timed out")

    monkeypatch.setattr(smtplib, "SMTP", refuse)

    with caplog.at_level(logging.ERROR, logger="core.email"), pytest.raises(EmailSendError):
        send_email(to="lea@example.com", subject="hi", body="body")

    assert "SMTP send failed" in caplog.text
    assert "mail.infomaniak.com:587" in caplog.text
    assert "TimeoutError" in caplog.text


def test_a_mail_outage_never_fails_the_sign_in_request(monkeypatch, caplog, client, session):
    """The API contract: a broken relay must not turn into a 500."""
    from identity.models import User, UserRole

    user = User(email="lea@example.com", name="Léa", role=UserRole.member)
    session.add(user)
    session.commit()

    configure(
        monkeypatch,
        smtp_host="mail.infomaniak.com",
        smtp_username="piggy@example.com",
        smtp_password="wrong",
    )

    def fail(host, port, timeout=None, context=None):
        conn = FakeSMTP(host, port, timeout)
        conn.login_error = smtplib.SMTPAuthenticationError(535, b"5.7.8 Authentication failed")
        return conn

    monkeypatch.setattr(smtplib, "SMTP", fail)

    with caplog.at_level(logging.WARNING):
        resp = client.post("/api/auth/code/request", json={"email": "lea@example.com"})

    assert resp.status_code == 202
    # And the operator is told how to get in while the relay is down.
    assert "manage login-code --email lea@example.com" in caplog.text
