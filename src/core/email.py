"""Outgoing email — SMTP when configured, the server log otherwise.

The console fallback is not a stub to replace later: in development the log
IS the mailbox, and `manage login-code` is the break-glass equivalent in
production when a mailbox can't be read.

Every exit from here is logged, because the only thing worse than mail not
arriving is mail not arriving quietly. A failed send records which host it
failed against, as which user, and at which step — a refused password does
not read like a refused connection.
"""

import logging
import smtplib
import ssl
from email.message import EmailMessage

from core.config import Settings, get_settings

logger = logging.getLogger(__name__)

# Infomaniak — like Gmail and Fastmail — refuses the mailbox's own password at
# the SMTP door and wants a separately issued one. Provisioning a mailbox with
# a generated password therefore produces credentials that work in webmail and
# are still rejected here, which is exactly what this hint exists to name.
AUTH_HINT = (
    "the relay refused these credentials. On Infomaniak, SMTP submission wants an "
    "application password — Manager > Mail > the mailbox > connected devices "
    '("appareil connecté") — not the mailbox password itself. A password that signs '
    "into webmail is not evidence that it will authenticate here."
)

# 465 is implicit TLS: the socket is wrapped before the greeting, and issuing
# STARTTLS on it is a protocol error rather than an upgrade.
IMPLICIT_TLS_PORT = 465


class EmailSendError(RuntimeError):
    """SMTP was configured and the message still did not get through."""


def _redact(value: bytes | str | None) -> str:
    if value is None:
        return ""
    return value.decode("utf-8", "replace") if isinstance(value, bytes) else value


def _connect(settings: Settings) -> smtplib.SMTP:
    if settings.smtp_port == IMPLICIT_TLS_PORT:
        return smtplib.SMTP_SSL(
            settings.smtp_host,
            settings.smtp_port,
            timeout=settings.smtp_timeout,
            context=ssl.create_default_context(),
        )
    return smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=settings.smtp_timeout)


def send_email(to: str, subject: str, body: str) -> None:
    """Send one message, or explain in the log why it could not be sent.

    Raises :class:`EmailSendError` when SMTP is configured but the send fails.
    Callers that must not fail on a mail outage catch it; the log has already
    recorded the diagnosis by then.
    """
    settings = get_settings()

    if not settings.smtp_host or not settings.smtp_username:
        configured = (("SMTP_HOST", settings.smtp_host), ("SMTP_USERNAME", settings.smtp_username))
        missing = " and ".join(name for name, value in configured if not value)
        logger.info("no SMTP configured (%s empty) — logging %r for %s instead of sending it", missing, subject, to)
        print(f"\n--- email to {to} ---\n{subject}\n\n{body}\n---\n", flush=True)
        return

    route = f"{settings.smtp_username} -> {to} via {settings.smtp_host}:{settings.smtp_port}"

    if not settings.smtp_password:
        # Worth its own line: an empty password reaches the relay as a failed
        # login, and "authentication failed" would send you hunting for a bad
        # password rather than a missing one.
        logger.error("SMTP_PASSWORD is empty while SMTP_HOST is set — cannot send %r to %s", subject, to)
        raise EmailSendError(f"SMTP_PASSWORD is empty; refusing to attempt {route}")

    msg = EmailMessage()
    msg["From"] = settings.email_sender
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)

    logger.info("sending %r as %s (from %s)", subject, route, settings.email_sender)
    try:
        with _connect(settings) as smtp:
            if settings.smtp_debug:
                smtp.set_debuglevel(1)
            if settings.smtp_port != IMPLICIT_TLS_PORT:
                smtp.starttls(context=ssl.create_default_context())
            smtp.login(settings.smtp_username, settings.smtp_password)
            smtp.send_message(msg)
    except smtplib.SMTPAuthenticationError as exc:
        logger.error("SMTP login refused for %s [%s %s] — %s", route, exc.smtp_code, _redact(exc.smtp_error), AUTH_HINT)
        raise EmailSendError(f"SMTP login refused for {route}: {AUTH_HINT}") from exc
    except smtplib.SMTPSenderRefused as exc:
        logger.error(
            "SMTP refused %s as the sender for %s [%s %s] — the relay usually requires the From address to be the "
            "authenticated mailbox itself",
            settings.email_sender,
            route,
            exc.smtp_code,
            _redact(exc.smtp_error),
        )
        raise EmailSendError(f"sender {settings.email_sender} refused for {route}") from exc
    except (smtplib.SMTPException, OSError, ssl.SSLError) as exc:
        logger.exception("SMTP send failed for %s (%s)", route, type(exc).__name__)
        raise EmailSendError(f"SMTP send failed for {route}: {exc}") from exc

    logger.info("sent %r to %s", subject, to)
