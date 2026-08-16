"""Outgoing email — SMTP when configured, the server log otherwise.

The console fallback is not a stub to replace later: in development the log
IS the mailbox, and `manage login-code` is the break-glass equivalent in
production when a mailbox can't be read.
"""

import logging
import smtplib
from email.message import EmailMessage

from core.config import get_settings

logger = logging.getLogger(__name__)


def send_email(to: str, subject: str, body: str) -> None:
    settings = get_settings()
    if not settings.smtp_host or not settings.smtp_username:
        logger.info("email to %s [%s]:\n%s", to, subject, body)
        print(f"\n--- email to {to} ---\n{subject}\n\n{body}\n---\n", flush=True)
        return
    msg = EmailMessage()
    msg["From"] = settings.email_sender
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)
    with smtplib.SMTP(settings.smtp_host, settings.smtp_port) as smtp:
        smtp.starttls()
        smtp.login(settings.smtp_username, settings.smtp_password)
        smtp.send_message(msg)
